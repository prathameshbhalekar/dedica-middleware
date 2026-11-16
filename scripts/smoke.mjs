/**
 * Runs the built worker in workerd (the runtime Cloudflare runs it in) against a fake Dedica and a fake origin, and
 * checks the answers that depend on the runtime: timeouts and abort signals, Ed25519 signatures, streaming, and that
 * the origin always answers when Dedica doesn't. The unit tests (`npm test`) run in Node and can't show this.
 *
 *   npm run smoke
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as miniflare from "miniflare";

const OUT = ".wrangler/smoke";
const SITE = "https://shop.example";
const API = "https://api.dedica.test";
const BROWSER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const GPTBOT = { "user-agent": "Mozilla/5.0; compatible; GPTBot/1.2; +https://openai.com/gptbot" };

execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", OUT], { stdio: ["ignore", "ignore", "inherit"] });

// A signing agent the policy knows and blocks, to exercise Ed25519 verification in the runtime.
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
const now = new Date().toISOString();

const fixture = JSON.parse(readFileSync("test/policy.fixture.json", "utf8"));
const policy = {
  ...fixture,
  mode: "autopilot",
  artifacts: [{ path: "/llms.txt", contentType: "text/plain; charset=utf-8" }],
  proxies: [{ path: "/mcp", targets: { POST: `${API}/mcp/` } }],
  access: {
    ...fixture.access,
    enforce: true,
    blockedAgentUa: ["claudebot"],
    blockedAgentKeys: ["chatgpt-agent"],
    verification: {
      maxAgeSeconds: 86400,
      claims: [],
      claimsExact: [],
      agentIpSets: {},
      ipSets: {},
      signatureAgents: [{ signatureAgent: "chatgpt.com", agents: ["chatgpt-agent"], fetchedAt: now, keys: [{ kid: "k1", x: publicKey }] }],
    },
  },
};

/** What the fake Dedica does: `up`, `error` (answers 500) or `hang` (never answers). */
let dedica = "up";
const seen = [];

async function outbound(request) {
  const url = new URL(request.url);
  if (url.origin === SITE) return new Response("origin page", { headers: { "content-type": "text/html" } });
  if (url.origin !== API) return new Response("unexpected host", { status: 502 });
  seen.push(url.pathname);
  if (dedica === "error") return new Response("dedica error", { status: 500 });
  if (dedica === "hang") return new Promise(() => {});
  if (url.pathname === "/api/v1/middleware/policy/") return Response.json(policy);
  if (url.pathname === "/api/v1/middleware/events/") return new Response('{"accepted":1}', { status: 202 });
  if (url.pathname === "/mcp/") return new Response(`mcp:${await request.text()}`, { headers: { "content-type": "application/json" } });
  if (url.pathname.startsWith("/api/v1/middleware/serve/")) {
    return new Response(`dedica:${url.pathname.split("/serve/")[1]}`, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "max-age=60" } });
  }
  return new Response("not found", { status: 404 });
}

function worker(bindings = {}) {
  const options = {
    modules: true,
    scriptPath: `${OUT}/index.js`,
    compatibilityDate: "2026-10-01",
    bindings: { DEDICA_SITE_ID: fixture.siteId, DEDICA_API_URL: API, DEDICA_MIDDLEWARE_TOKEN: "dm_smoke", ...bindings },
    outboundService: outbound,
  };
  // Miniflare 5 takes a new options shape, and converts this one.
  return new miniflare.Miniflare(miniflare.convertV4MiniflareOptions?.(options) ?? options);
}

let failed = 0;
async function check(name, mf, path, init, expected) {
  const started = Date.now();
  let got;
  try {
    const response = await mf.dispatchFetch(`${SITE}${path}`, init);
    got = { status: response.status, body: await response.text() };
  } catch (error) {
    got = { status: 0, body: String(error) };
  }
  const ms = Date.now() - started;
  const ok = got.status === expected.status && got.body.includes(expected.body) && (expected.withinMs === undefined || ms <= expected.withinMs);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${ms} ms)${ok ? "" : `\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(got)}`}`);
}

async function signedHeaders() {
  const created = Math.floor(Date.now() / 1000);
  const params = `("@authority" "signature-agent");created=${created};expires=${created + 60};keyid="k1";alg="ed25519";tag="web-bot-auth"`;
  const base = `"@authority": shop.example\n"signature-agent": "https://chatgpt.com"\n"@signature-params": ${params}`;
  const signature = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(base))).toString("base64");
  return { ...BROWSER, "signature-agent": '"https://chatgpt.com"', "signature-input": `sig1=${params}`, signature: `sig1=:${signature}:` };
}

const mf = worker();
try {
  await check("status", mf, "/__dedica/status", {}, { status: 200, body: '"configured":true' });
  await check("installation proof", mf, "/.well-known/dedica.json", {}, { status: 200, body: '"middleware":"cloudflare-worker"' });
  await check("a person gets the origin's page", mf, "/pricing", { headers: BROWSER }, { status: 200, body: "origin page" });
  await check("an agent gets the agent version", mf, "/pricing", { headers: GPTBOT }, { status: 200, body: "dedica:pricing" });
  await check("a markdown URL", mf, "/pricing.md", { headers: BROWSER }, { status: 200, body: "dedica:pricing.md" });
  await check("an artifact", mf, "/llms.txt", { headers: BROWSER }, { status: 200, body: "dedica:llms.txt" });
  await check("a HEAD of an artifact has no body", mf, "/llms.txt", { method: "HEAD" }, { status: 200, body: "" });
  await check("a proxied path, with its body", mf, "/mcp", { method: "POST", body: '{"q":1}', headers: { "content-type": "application/json" } }, { status: 200, body: 'mcp:{"q":1}' });
  await check("a bot blocked by user agent", mf, "/pricing", { headers: { "user-agent": "ClaudeBot/1.0" } }, { status: 403, body: "Not available" });
  await check("an agent blocked by its Ed25519 signature", mf, "/pricing", { headers: await signedHeaders() }, { status: 403, body: "Not available" });
  await check("a POST reaches the origin", mf, "/checkout", { method: "POST", body: "a=1", headers: BROWSER }, { status: 200, body: "origin page" });

  // Dedica stops answering while the worker holds a policy: the origin answers, and an agent never waits long.
  dedica = "hang";
  await check("Dedica hangs: a person is not held up", mf, "/pricing", { headers: BROWSER }, { status: 200, body: "origin page", withinMs: 1000 });
  await check("Dedica hangs: an agent gets the origin within the 1.5 s limit", mf, "/about", { headers: GPTBOT }, { status: 200, body: "origin page", withinMs: 2500 });
  await check("Dedica hangs: later requests don't wait at all", mf, "/about", { headers: GPTBOT }, { status: 200, body: "origin page", withinMs: 1000 });
  dedica = "error";
  await check("Dedica errors: a markdown URL falls back to the origin", mf, "/pricing.md", { headers: BROWSER }, { status: 200, body: "origin page" });
  await check("Dedica errors: a proxied path relays Dedica's own answer (SPEC 3.4)", mf, "/mcp", { method: "POST", body: "x" }, { status: 500, body: "dedica error" });
} finally {
  await mf.dispose();
}

// A cold worker (no policy yet) in front of a Dedica that errors, or that never answers.
dedica = "error";
const cold = worker();
try {
  await check("cold worker, Dedica errors: the origin answers", cold, "/pricing", { headers: BROWSER }, { status: 200, body: "origin page", withinMs: 2000 });
} finally {
  await cold.dispose();
}
dedica = "hang";
const stalled = worker();
try {
  await check("cold worker, Dedica hangs: the origin answers after the 4 s policy limit", stalled, "/pricing", { headers: BROWSER }, { status: 200, body: "origin page", withinMs: 6000 });
  await check("... and the next request doesn't wait", stalled, "/pricing", { headers: BROWSER }, { status: 200, body: "origin page", withinMs: 1000 });
} finally {
  await stalled.dispose();
}

// The kill switch: no call to Dedica at all.
dedica = "up";
seen.length = 0;
const off = worker({ DEDICA_DISABLED: "1" });
try {
  await check("kill switch: an agent gets the origin's page", off, "/pricing", { headers: GPTBOT }, { status: 200, body: "origin page" });
  await check("kill switch: status shows it", off, "/__dedica/status", {}, { status: 200, body: '"disabled":true' });
  if (seen.length > 0) {
    failed++;
    console.log(`FAIL kill switch: the worker still called Dedica (${seen.join(", ")})`);
  }
} finally {
  await off.dispose();
}

console.log(failed === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
