/**
 * The worker's wiring: per-isolate state, the steps before the policy (status, kill switch, installation proof),
 * carrying out what `decide.ts` decided, and reporting. What a request gets is decided in decide.ts, not here.
 */

import { BLOCKED_BODY } from "./agents/access";
import { clientMatch, userAgent } from "./agents/classify";
import { type Identity, identify } from "./agents/identity";
import { type Blocked, type Content, type PageDecision, TEXT, type Visit, decide, decideForDedicaCrawler } from "./decide";
import { ContentClient } from "./dedica/content";
import { Reporter, type Trace, buildEvent, isReportable } from "./dedica/events";
import { PolicyStore } from "./dedica/policy-store";
import { proxyRequest } from "./dedica/proxy";
import {
  HEARTBEAT_TIMEOUT_MS,
  MIDDLEWARE,
  ORIGIN_FETCH_HEADER,
  STATUS_PATH,
  VERSION,
  WELL_KNOWN_PATH,
  configured,
  dedicaInit,
  dedicaUrl,
  disabled,
} from "./env";
import type { Ctx, Env, FetchFn, Policy } from "./types";

export interface EdgeOptions {
  /** Calls to Dedica (and nothing else). */
  dedicaFetch?: FetchFn;
  /** Calls to the customer's origin. */
  originFetch?: (request: Request) => Promise<Response>;
  now?: () => number;
  /** Waits before a traffic batch is sent (tests pass one that doesn't wait). */
  sleep?: (ms: number) => Promise<void>;
}

/** The response a request gets, and how it came about (for the traffic event). */
interface Answer extends Trace {
  response: Response;
}

/** All per-isolate state of the worker. Tests build their own; the deployed worker uses one. */
export class Edge {
  readonly policies: PolicyStore;
  private readonly content: ContentClient;
  private readonly dedicaFetch: FetchFn;
  private readonly originFetch: (request: Request) => Promise<Response>;
  private readonly now: () => number;
  readonly reporter: Reporter;

  constructor(options: EdgeOptions = {}) {
    this.dedicaFetch = options.dedicaFetch ?? ((input, init) => fetch(input, init));
    this.originFetch = options.originFetch ?? ((request) => fetch(request));
    this.now = options.now ?? Date.now;
    this.policies = new PolicyStore(this.dedicaFetch, this.now);
    this.content = new ContentClient(this.dedicaFetch, this.now);
    this.reporter = new Reporter(this.dedicaFetch, options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  }

  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // If this worker ever throws, Cloudflare sends the request to the origin instead of an error page.
    ctx.passThroughOnException?.();
    const url = new URL(request.url);

    // 1. Read-only configuration check: no secrets, no calls to Dedica. Answers even when disabled, to show it.
    if (request.method === "GET" && url.pathname === STATUS_PATH) {
      return Response.json(
        {
          configured: configured(env),
          disabled: disabled(env),
          siteId: env.DEDICA_SITE_ID || null,
          mode: this.policies.policy?.mode ?? null,
          version: VERSION,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // 2. Kill switch: everything goes to the origin untouched, unreported, with no call to Dedica.
    if (disabled(env)) return this.originFetch(request);

    // 3. Installation proof.
    if (request.method === "GET" && url.pathname === WELL_KNOWN_PATH) {
      return Response.json(
        { site_id: env.DEDICA_SITE_ID ?? null, middleware: MIDDLEWARE, version: VERSION },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // 4. Not set up yet: pass straight through, unreported.
    if (!configured(env)) return this.originFetch(request);

    const startedAt = this.now();
    const ua = userAgent(request.headers);
    let identity: Promise<Identity | null> | null = null;
    const visit: Visit = {
      request,
      url,
      ua,
      acceptsMarkdown: (request.headers.get("accept") ?? "").includes("text/markdown"),
      identity: (p) => {
        identity ??= p?.access?.verification
          ? identify(p.access.verification, request, ua, clientMatch(request.headers, p.detection).kind !== "unknown", this.now()).catch(() => null)
          : Promise.resolve(null);
        return identity;
      },
    };
    // 5. Dedica's own crawler reading the origin's page: never Dedica's content, and unreported. The header proves
    // nothing (anyone can send it), so it never skips Agent Access: a blocked bot sending it is still blocked.
    if (request.headers.get(ORIGIN_FETCH_HEADER) === "1") {
      const blocked = await this.crawlerBlock(visit, env, ctx).catch(() => null);
      if (!blocked) return this.originFetch(request);
      this.report(visit, blocked, env, ctx, startedAt);
      return blocked.response;
    }
    // 6. Everyone else: Dedica's answer if decide.ts says so and Dedica has one, else the origin's.
    const answer = await this.answer(visit, env, ctx);
    this.report(visit, answer, env, ctx, startedAt);
    return answer.response;
  }

  /** Agent Access for a request marked as Dedica's crawler: the same rules as for anyone. */
  private async crawlerBlock(visit: Visit, env: Env, ctx: Ctx): Promise<Answer | null> {
    if (visit.request.method !== "GET" && visit.request.method !== "HEAD") return null;
    const decision = await decideForDedicaCrawler(visit, await this.policies.get(env, ctx));
    return decision.kind === "blocked" ? blockedAnswer(decision) : null;
  }

  /** Dedica's answer, else the origin's, returned untouched. Any failure on Dedica's side ends at the origin. */
  private async answer(visit: Visit, env: Env, ctx: Ctx): Promise<Answer> {
    const fromDedica = await this.fromDedica(visit, env, ctx).catch((error: unknown) => {
      console.warn(`[dedica] serving failed; using origin: ${error}`);
      return "origin" as const;
    });
    if (typeof fromDedica !== "string") return fromDedica;
    return { response: await this.originFetch(visit.request), outcome: fromDedica, category: null };
  }

  /** Decides (decide.ts) and carries the decision out. A string means the origin answers, reported as that. */
  private async fromDedica(visit: Visit, env: Env, ctx: Ctx): Promise<Answer | "origin" | "human_page"> {
    // Every request waits for a missing policy (at most POLICY_TIMEOUT_MS, shared by all requests waiting on it),
    // so a cold isolate answers the same as a warm one. Without a policy, the origin answers.
    const p = await this.policies.get(env, ctx);

    let decision = await decide(visit, p);
    if (decision.kind === "proxy") {
      const response = await proxyRequest(visit.request, visit.url, p, env, this.dedicaFetch);
      if (response) return { response, outcome: "proxied", category: null };
      decision = await decision.otherwise();
    }
    return this.carryOut(decision, visit.request, p, env);
  }

  private async carryOut(decision: PageDecision, request: Request, p: Policy | null, env: Env): Promise<Answer | "origin" | "human_page"> {
    switch (decision.kind) {
      case "origin":
        return decision.outcome;
      case "blocked":
        return blockedAnswer(decision);
      case "artifact_blocked":
        return { response: new Response(BLOCKED_BODY, { status: 403 }), outcome: "blocked", category: "public" };
      case "content": {
        if (!p) return "origin";
        if (decision.originFirst) return this.originFirst(decision, request, p, env);
        const response = await this.fetchContent(decision, request, p, env);
        return response ? { response, outcome: decision.outcome, category: decision.input.category } : "origin";
      }
    }
  }

  /** A `fallback` artifact: the origin's own file when it has one, else Dedica's, else the origin's answer after all. */
  private async originFirst(decision: Content, request: Request, p: Policy, env: Env): Promise<Answer> {
    const origin = await this.originFetch(request).catch(() => null);
    if (!(origin && originHasFile(origin))) {
      const fromDedica = await this.fetchContent(decision, request, p, env).catch((error: unknown) => {
        console.warn(`[dedica] serving failed; using origin: ${error}`);
        return null;
      });
      if (fromDedica) {
        void origin?.body?.cancel().catch(() => {});
        return { response: fromDedica, outcome: "artifact", category: "public" };
      }
    }
    return { response: origin ?? (await this.originFetch(request)), outcome: "artifact_origin", category: "public" };
  }

  private fetchContent(decision: Content, request: Request, p: Policy, env: Env): Promise<Response | null> {
    return this.content.fromDedica(p, env, decision.input, decision.contentType, decision.shared, request);
  }

  /** Reports the request to Dedica in the background, batched (see dedica/events.ts). Never throws. */
  private report(visit: Visit, answer: Answer, env: Env, ctx: Ctx, startedAt: number): void {
    try {
      if (!isReportable(visit.url, visit.request.headers)) return;
      const policy = this.policies.policy;
      ctx.waitUntil(
        visit
          .identity(policy)
          .then((identity) => buildEvent(visit.request, answer.response, answer, policy, env, startedAt, this.now(), identity))
          .then((event) => this.reporter.add(event, env, ctx))
          .catch((error: unknown) => console.warn(`[dedica] event report skipped: ${error}`)),
      );
    } catch (error) {
      console.warn(`[dedica] event report skipped: ${error}`);
    }
  }

  async heartbeat(env: Env): Promise<void> {
    if (disabled(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_DISABLED is set");
      return;
    }
    if (!configured(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_SITE_ID, DEDICA_API_URL or DEDICA_MIDDLEWARE_TOKEN is not set");
      return;
    }
    try {
      const response = await this.dedicaFetch(
        dedicaUrl(env, "heartbeat"),
        dedicaInit(env, HEARTBEAT_TIMEOUT_MS, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ middleware: MIDDLEWARE, version: VERSION }),
        }),
      );
      if (!response.ok) console.warn(`[dedica] heartbeat failed: ${response.status}`);
    } catch (err) {
      console.warn(`[dedica] heartbeat request failed: ${err}`);
    }
  }
}

/** The 403 an Agent Access rule answers. Never cached: it is for this client only, and a cache that kept it would
 *  show it to everyone else at the URL. */
function blockedAnswer(decision: Blocked): Answer {
  const headers = { "cache-control": "no-store" };
  const response =
    decision.reply === "json"
      ? Response.json({ error: "QUERY_FORBIDDEN", message: BLOCKED_BODY }, { status: 403, headers })
      : new Response(BLOCKED_BODY, { status: 403, headers: { "content-type": TEXT, ...headers } });
  return { response, outcome: "blocked", category: null, blockRule: decision.rule };
}

/** A real file at the origin: any redirect, or a 2xx that isn't an HTML page (a single-page app answers every path). */
function originHasFile(response: Response): boolean {
  if (response.status >= 300 && response.status < 400) return true;
  if (response.status < 200 || response.status >= 300) return false;
  return !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
