/**
 * The request order (SPEC section 6, steps 6a-6k): what to do with a request, decided from the request and the
 * policy alone. Nothing here calls Dedica or the origin; `Edge` carries the decision out and falls back to the
 * origin whenever Dedica has no answer.
 *
 * Read `decide` top to bottom to see what a request gets. The first step that applies ends the decision.
 */

import { type BlockRule, accessBlock, routeForRequest } from "./agents/access";
import { detectAgent, isTraditionalBot, keepHumanPage } from "./agents/classify";
import type { Identity } from "./agents/identity";
import type { ContentInput } from "./dedica/content";
import { proxyTargetUrl } from "./dedica/proxy";
import { NEGOTIATE_TIMEOUT_MS } from "./env";
import { isPageRead, twinEligible } from "./page";
import type { Policy } from "./types";

export const TEXT = "text/plain; charset=utf-8";

/** What the worker needs to know about a request, worked out once. */
export interface Visit {
  request: Request;
  url: URL;
  /** The user agent, cut and lowercased (see `userAgent`). */
  ua: string;
  /** `Accept: text/markdown`. */
  acceptsMarkdown: boolean;
  /** Who the client really is (Agent Access), worked out at most once, and only when something needs it. */
  identity: (p: Policy | null) => Promise<Identity | null>;
}

/** The origin answers. `human_page`: a search engine, preview or unknown crawler kept the person's page. */
export interface Origin {
  kind: "origin";
  outcome: "origin" | "human_page";
}

/** An Agent Access rule answers 403: as text on a page, as JSON on a proxied path. */
export interface Blocked {
  kind: "blocked";
  rule: BlockRule;
  reply: "text" | "json";
}

/** An artifact the policy blocks for everyone: 403. */
export interface ArtifactBlocked {
  kind: "artifact_blocked";
}

/** Ask Dedica for a file; if it has none, the origin answers. */
export interface Content {
  kind: "content";
  outcome: "artifact" | "twin" | "negotiated";
  input: ContentInput & { category: "public" | "eligible" };
  /** Used when Dedica sends no content type. */
  contentType: string;
  /** The same for every visitor: cacheable, and the visitor's validators are forwarded. */
  shared: boolean;
  /** A `fallback` artifact: the origin's own file wins when it has one. */
  originFirst: boolean;
}

/** Hand the request to Dedica (`/ask`, `/mcp`). If it can't be proxied, `otherwise` decides. */
export interface Proxied {
  kind: "proxy";
  otherwise: () => Promise<PageDecision>;
}

export type PageDecision = Origin | Blocked | ArtifactBlocked | Content;
export type Decision = PageDecision | Proxied;

const ORIGIN: Origin = { kind: "origin", outcome: "origin" };

const isRead = (request: Request): boolean => request.method === "GET" || request.method === "HEAD";

function blockRule(visit: Visit, p: Policy): Promise<BlockRule | null> {
  return accessBlock(visit.request.headers, visit.ua, visit.url.pathname, p, () => visit.identity(p));
}

/** Step 5: a request marked as Dedica's crawler. Agent Access applies as for anyone; otherwise the origin answers. */
export async function decideForDedicaCrawler(visit: Visit, p: Policy | null): Promise<Origin | Blocked> {
  if (!p || !isRead(visit.request)) return ORIGIN;
  const rule = await blockRule(visit, p);
  return rule ? { kind: "blocked", rule, reply: "text" } : ORIGIN;
}

/** Step 6: every other request. `p` is the policy (6a), or null when there is none. */
export async function decide(visit: Visit, p: Policy | null): Promise<Decision> {
  const { request, url } = visit;

  // 6b. A path the policy proxies to Dedica (`/ask`, `/mcp`, ...), any method; independent of agent detection.
  //     A bot the site's Agent Access rules block gets a JSON 403, before anything reaches Dedica, and a
  //     `passthrough` route leaves the path to the origin (the site's own `/mcp`, say).
  if (p && proxyTargetUrl(url, request.method, p) !== null) {
    const rule = await blockRule(visit, p);
    if (rule) return { kind: "blocked", rule, reply: "json" };
    if (routeForRequest(p, url.pathname)?.action === "passthrough") return ORIGIN;
    return { kind: "proxy", otherwise: () => decidePage(visit, p) };
  }
  return decidePage(visit, p);
}

/** Steps 6c-6k: everything that isn't proxied, and a proxied path that could not be proxied. */
async function decidePage(visit: Visit, p: Policy | null): Promise<PageDecision> {
  const { request, url, ua } = visit;

  // 6c. Only reads get anything from Dedica.
  if (!isRead(request)) return ORIGIN;
  // 6d. No policy, or `report` mode.
  if (!p || p.mode !== "autopilot") return ORIGIN;

  // 6e. A file Dedica manages (llms.txt, ...), for every visitor, and before any block rule: a blocked crawler can
  //     still read the `/robots.txt` that tells it so.
  const artifact = p.artifacts.find((a) => a.path === url.pathname);
  if (artifact) {
    const action = artifact.action ?? "proxy";
    if (action === "block") return { kind: "artifact_blocked" };
    if (action !== "proxy" && action !== "fallback") return ORIGIN;
    return {
      kind: "content",
      outcome: "artifact",
      input: { path: artifact.path, version: artifact.version, category: "public" },
      contentType: artifact.contentType,
      shared: true,
      originFirst: action === "fallback",
    };
  }

  // 6f. Agent Access: a bot this site blocks, or a route it blocks for agents (see agents/access.ts).
  const rule = await blockRule(visit, p);
  if (rule) return { kind: "blocked", rule, reply: "text" };
  // 6g. A `passthrough` route leaves the path, and its `.md` version, to the origin.
  if (routeForRequest(p, url.pathname)?.action === "passthrough") return ORIGIN;

  const questionParams = p.twins.questionParams ?? [];
  const asksQuestion =
    questionParams.some((key) => Boolean(url.searchParams.get(key)?.trim())) || (questionParams.length > 0 && /~~.+/.test(url.pathname));

  // 6h. Search engines, link previews and (unknown) crawlers keep the person's page, unless they ask a question.
  if (keepHumanPage(ua, p.detection, asksQuestion)) return { kind: "origin", outcome: "human_page" };

  // 6i. An explicit markdown URL (`/pricing.md`), for anyone who asks. A declared question makes the answer
  //     personal, so it is never shared-cached.
  if (p.twins.enabled && url.pathname.endsWith(p.twins.suffix)) {
    const page = url.pathname.slice(0, -p.twins.suffix.length) || "/";
    if (!twinEligible(page, p.twins)) return ORIGIN;
    return {
      kind: "content",
      outcome: "twin",
      input: { path: url.pathname, search: url.search, category: "public" },
      contentType: TEXT,
      shared: !questionParams.some((key) => url.searchParams.has(key)),
      originFirst: false,
    };
  }

  // 6j. The agent version of a page, for a detected agent or a client asking for `text/markdown`. Never for a
  //     search engine, an API call or a page's sub-request (see `isPageRead`), and never a long wait: the client
  //     asked for the origin's page.
  if (!p.twins.negotiate || !isPageRead(request.headers, url.pathname)) return ORIGIN;
  const wantsAgentVersion = visit.acceptsMarkdown || detectAgent(request.headers, p.detection);
  if (!isTraditionalBot(ua, p.detection) && twinEligible(url.pathname, p.twins) && wantsAgentVersion) {
    return {
      kind: "content",
      outcome: "negotiated",
      input: { path: url.pathname, search: url.search, category: "eligible", timeoutMs: NEGOTIATE_TIMEOUT_MS },
      contentType: TEXT,
      shared: false,
      originFirst: false,
    };
  }

  // 6k.
  return ORIGIN;
}
