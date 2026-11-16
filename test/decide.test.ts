/** The request order, one row per step of SPEC section 6. No Dedica, no origin: `decide` only decides. */

import { describe, expect, it } from "vitest";

import { userAgent } from "../src/agents/classify";
import { type Decision, type Visit, decide, decideForDedicaCrawler } from "../src/decide";
import { NEGOTIATE_TIMEOUT_MS } from "../src/env";
import type { Access, Policy } from "../src/types";
import { API, BROWSER_UA, GOOGLEBOT_UA, GPTBOT_UA, browserHeaders, get, policy } from "./helpers";

const ORIGIN = { kind: "origin", outcome: "origin" };
const bot = { "user-agent": GPTBOT_UA };

function visit(request: Request): Visit {
  return {
    request,
    url: new URL(request.url),
    ua: userAgent(request.headers),
    acceptsMarkdown: (request.headers.get("accept") ?? "").includes("text/markdown"),
    identity: async () => null,
  };
}

function access(overrides: Partial<Access> = {}): Access {
  return {
    enforce: true,
    impersonators: "flag",
    blockedAgentUa: [],
    blockedAgentUaExact: [],
    blockedServeHumanUa: [],
    blockedServeHumanUaExact: [],
    blockedAgentKeys: [],
    routes: [],
    verification: null,
    ...overrides,
  };
}

const proxies = [{ path: "/mcp", targets: { POST: `${API}/mcp/`, GET: `${API}/mcp/` } }];
const llms = { path: "/llms.txt", contentType: "text/plain", version: "v9" };

/** The final decision: a proxied path's `otherwise` is followed, as when Dedica could not take the request. */
async function unproxied(decision: Decision): Promise<Decision> {
  return decision.kind === "proxy" ? decision.otherwise() : decision;
}

describe("the request order (SPEC 6)", () => {
  const rows: [string, Request, Policy | null, object][] = [
    ["6b a proxied path is proxied, any method", get("/mcp", bot, { method: "POST" }), policy({ proxies }), { kind: "proxy" }],
    [
      "6b a blocked bot gets a JSON 403 on a proxied path",
      get("/mcp", bot, { method: "POST" }),
      policy({ proxies, access: access({ blockedAgentUa: ["gptbot"] }) }),
      { kind: "blocked", rule: "crawler", reply: "json" },
    ],
    [
      "6b a passthrough route keeps a proxied path at the origin",
      get("/mcp", bot, { method: "POST" }),
      policy({ proxies, access: access({ routes: [{ id: "r", kind: "exact", path: "/mcp", action: "passthrough" }] }) }),
      ORIGIN,
    ],
    ["6b nothing is proxied in report mode", get("/mcp", bot, { method: "POST" }), policy({ proxies, mode: "report" }), ORIGIN],
    ["6c a write is the origin's", get("/pricing", bot, { method: "POST" }), policy(), ORIGIN],
    ["6d no policy", get("/pricing.md", bot), null, ORIGIN],
    ["6d report mode", get("/pricing.md", bot), policy({ mode: "report" }), ORIGIN],
    [
      "6e an artifact, for a person too",
      get("/llms.txt", browserHeaders),
      policy({ artifacts: [llms] }),
      { kind: "content", outcome: "artifact", input: { path: "/llms.txt", version: "v9", category: "public" }, contentType: "text/plain", shared: true, originFirst: false },
    ],
    ["6e a fallback artifact asks the origin first", get("/llms.txt"), policy({ artifacts: [{ ...llms, action: "fallback" }] }), { kind: "content", originFirst: true }],
    ["6e a blocked artifact", get("/llms.txt"), policy({ artifacts: [{ ...llms, action: "block" }] }), { kind: "artifact_blocked" }],
    ["6e a passthrough artifact", get("/llms.txt", bot), policy({ artifacts: [{ ...llms, action: "passthrough" }] }), ORIGIN],
    [
      "6e an artifact comes before the block rules",
      get("/llms.txt", bot),
      policy({ artifacts: [llms], access: access({ blockedAgentUa: ["gptbot"] }) }),
      { kind: "content", outcome: "artifact" },
    ],
    ["6f a blocked bot gets a text 403 on a page", get("/pricing", bot), policy({ access: access({ blockedAgentUa: ["gptbot"] }) }), { kind: "blocked", rule: "crawler", reply: "text" }],
    [
      "6f a blocked route, for an agent",
      get("/private/x", bot),
      policy({ access: access({ routes: [{ id: "r", kind: "prefix", path: "/private", action: "block" }] }) }),
      { kind: "blocked", rule: "route", reply: "text" },
    ],
    [
      "6f a blocked route never blocks a person",
      get("/private/x", browserHeaders),
      policy({ access: access({ routes: [{ id: "r", kind: "prefix", path: "/private", action: "block" }] }) }),
      ORIGIN,
    ],
    [
      "6g a passthrough route keeps the page's .md at the origin",
      get("/docs.md", bot),
      policy({ access: access({ routes: [{ id: "r", kind: "exact", path: "/docs", action: "passthrough" }] }) }),
      ORIGIN,
    ],
    ["6h a search engine keeps the person's page, even at a .md URL", get("/pricing.md", { "user-agent": GOOGLEBOT_UA }), policy(), { kind: "origin", outcome: "human_page" }],
    [
      "6i an explicit markdown URL, for a person too",
      get("/pricing.md?utm_source=x", browserHeaders),
      policy(),
      { kind: "content", outcome: "twin", input: { path: "/pricing.md", search: "?utm_source=x", category: "public" }, shared: true },
    ],
    [
      "6i a question makes the markdown private",
      get("/pricing.md?q=price", { "user-agent": BROWSER_UA }),
      policy({ twins: { ...policy().twins, questionParams: ["q"] } }),
      { kind: "content", outcome: "twin", shared: false },
    ],
    ["6i a markdown URL of an excluded page", get("/admin/x.md", bot), policy({ twins: { ...policy().twins, excludePaths: ["/admin"] } }), ORIGIN],
    [
      "6j the agent version of a page, for an agent",
      get("/pricing", bot),
      policy(),
      { kind: "content", outcome: "negotiated", input: { path: "/pricing", search: "", category: "eligible", timeoutMs: NEGOTIATE_TIMEOUT_MS }, shared: false },
    ],
    ["6j ... and for anyone asking for markdown", get("/pricing", { "user-agent": BROWSER_UA, accept: "text/markdown" }), policy(), { kind: "content", outcome: "negotiated" }],
    ["6j never with negotiation off", get("/pricing", bot), policy({ twins: { ...policy().twins, negotiate: false } }), ORIGIN],
    ["6j never for a request with a cookie", get("/pricing", { ...bot, cookie: "s=1" }), policy(), ORIGIN],
    ["6j never for a static file", get("/app.js", bot), policy(), ORIGIN],
    ["6k a person opening a page", get("/pricing", browserHeaders), policy(), ORIGIN],
  ];

  it.each(rows)("%s", async (_name, request, p, expected) => {
    expect(await decide(visit(request), p)).toMatchObject(expected);
  });

  it("6b -> 6c: a proxied path that could not be proxied carries on down the order", async () => {
    const p = policy({ proxies });
    expect(await unproxied(await decide(visit(get("/mcp", bot, { method: "POST" })), p))).toEqual(ORIGIN);
    expect(await unproxied(await decide(visit(get("/mcp", bot)), p))).toMatchObject({ kind: "content", outcome: "negotiated" });
  });
});

describe("Dedica's own crawler (SPEC 6, step 5)", () => {
  const blocking = policy({ access: access({ blockedAgentUa: ["gptbot"] }) });

  it("is blocked like anyone else, and otherwise always gets the origin", async () => {
    expect(await decideForDedicaCrawler(visit(get("/llms.txt", bot)), blocking)).toEqual({ kind: "blocked", rule: "crawler", reply: "text" });
    expect(await decideForDedicaCrawler(visit(get("/pricing.md", { "user-agent": BROWSER_UA })), blocking)).toEqual(ORIGIN);
    expect(await decideForDedicaCrawler(visit(get("/pricing", bot, { method: "POST" })), blocking)).toEqual(ORIGIN);
    expect(await decideForDedicaCrawler(visit(get("/pricing", bot)), null)).toEqual(ORIGIN);
  });
});
