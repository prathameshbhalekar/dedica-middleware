denied_status# Dedica Cloudflare Worker: Behaviour Specification

Worker version **1.4.0**, Dedica middleware protocol **v1**.

This document describes what the worker receives from Dedica, what it sends to Dedica, and how it answers every
request. It describes observable behaviour only.

Terms used throughout:

- **Origin**: the customer's site, answering exactly as it would without the worker.
- **Dedica**: the Dedica backend API.
- **Visitor**: whoever sent the request (a person's browser, a search engine, an AI agent, a script).
- **Policy**: the site's settings, fetched from Dedica (section 3.2).
- **User agent (UA)**: unless stated otherwise, the visitor's `User-Agent` header, **cut to its first 512 characters
  and lowercased**. Every list match against the user agent uses this form, so policy needles only match if they are
  lowercase.
- **Instance**: one running copy of the worker. Cloudflare may run many at once. Each instance keeps its own policy
  cache, back-off timers and unsent traffic events; nothing is shared between instances.

---

## 1. Guarantees

1. **Origin responses are never changed.** Whenever the origin answers, the visitor gets the origin's response
   exactly as the origin sent it, including errors and 404s. The origin always receives the visitor's original
   request.
2. **Anything unexpected falls back to the origin.** If Dedica is slow, down, answers with an error, has no content
   for a path, declines a request, or the worker itself fails, the origin answers. The one exception is proxied paths
   (3.4): once Dedica answers there, its answer is relayed as is, error statuses included.
3. **People and search engines get the normal page.** At a normal page URL, Dedica's agent version is never served
   to a search engine, to a request carrying cookies, credentials or a range, or to a page's sub-request; a browser
   navigation gets it only if it asks for `text/markdown` or carries a recognised `Signature-Agent`.
4. **Every call to Dedica has a time limit** (section 9).
5. **A malformed policy can only do less.** Invalid entries are dropped, and a policy the worker can't use safely is
   ignored entirely, so the site behaves as if the worker were not there.
6. **Reporting never affects a response.** Traffic events are sent in the background after the response.

---

## 2. Configuration

| Variable | Kind | Behaviour |
|---|---|---|
| `DEDICA_SITE_ID` | var | The site id. Required. |
| `DEDICA_API_URL` | var | Dedica's API base, e.g. `https://api.getdedica.com`. Trailing slashes are ignored. Required. (With only `DEDICA_POLICY_URL` set, the worker counts as configured and policy and serve calls work, but heartbeats and traffic events always fail, and proxied paths work only if `DEDICA_QUERY_ORIGIN` is set.) |
| `DEDICA_MIDDLEWARE_TOKEN` | secret | The middleware token (`dm_…`). Required. |
| `DEDICA_POLICY_URL` | var, optional | Replaces the policy URL only (testing). |
| `DEDICA_QUERY_ORIGIN` | var, optional | The only origin that proxied paths (section 3.4) may be sent to. Defaults to the origin of `DEDICA_API_URL`. |
| `DEDICA_SALT` | secret, optional | Salt for the daily visitor pseudonym in traffic events. Without it, no pseudonym is sent. |
| `DEDICA_DISABLED` | var, optional | Kill switch. `1`, `true`, `yes` or `on` (any case, surrounding spaces ignored) turn the worker off (section 6, step 2). Any other value, or unset, leaves it on. |

The worker is **configured** when it has a site id, a token, and either `DEDICA_API_URL` or `DEDICA_POLICY_URL`.

---

## 3. Communication with Dedica

### 3.1 Common to every call

Every call the worker makes to Dedica carries:

| Header | Value |
|---|---|
| `x-dedica-middleware-token` | the configured token |
| `x-dedica-transmitter` | `cloudflare-worker/1.4.0` |

Responses to policy, serve, heartbeat and event calls are never stored in Cloudflare's cache.

Policy, heartbeat and event calls follow redirects, sending the headers above to the redirect target. Serve and proxy
calls never follow redirects.

Endpoints below are relative to `DEDICA_API_URL`, except serve URLs and proxy targets, which come from the policy.

### 3.2 Policy

**Request:** `GET /api/v1/middleware/policy/` (or `DEDICA_POLICY_URL`), header `accept: application/json`, time
limit 4 s.

#### 3.2.1 How the response is handled

| Dedica answers | Effect | Next attempt no sooner than |
|---|---|---|
| 2xx with a usable policy | The policy is stored and used | when it expires |
| 401 or 403 | The stored policy is dropped immediately | 5 min |
| 408, 429 or 5xx | The stored policy is kept (within the limits of 3.2.2) | 15 s |
| Any other error status | The stored policy is dropped immediately | 15 s |
| 2xx with `schemaVersion` other than `1` | The stored policy is dropped immediately | 60 s |
| 2xx that fails validation (3.2.4) | The stored policy is dropped immediately | 60 s |
| Body that isn't JSON, network error, time limit reached | The stored policy is kept (within the limits of 3.2.2) | 15 s |

While waiting for the next attempt, no policy request is made and no request waits for one.

#### 3.2.2 Caching

- A policy is **fresh** for `ttlSeconds` after it was fetched.
- For **30 s after it expires**, it is still used as is, and a refresh starts in the background.
- **Later than that, or with no policy at all**, a request waits for a refresh (at most ~4 s), then continues with
  whatever policy is available.
- If a refresh fails, the old policy stays usable:
  - if it has `serve` settings: until **15 minutes** after its last successful fetch;
  - otherwise: until **30 s** after it expired.

  After that the instance has no policy and every request goes to the origin.
- Only one policy request is in flight per instance at a time. All requests waiting for a policy share it.

Consequence: a freshly started instance answers its first requests the same way a warmed-up one would, because they
wait for the policy. When Dedica is down, at most one ~4 s wait can recur every 15 s.

#### 3.2.3 Policy contents

```jsonc
{
  "schemaVersion": 1,             // must be exactly 1
  "ttlSeconds": 30,               // number; clamped to 5–300; default 30
  "version": "61c9d38e313cda3f",  // reported in events
  "siteId": "…",
  "mode": "autopilot",            // "report" | "autopilot"
  "detection": {
    "traditionalBots": ["googlebot", …],     // search engines, link previews, monitors (substring match)
    "traditionalBotsExact": [],              // whole-UA match
    "agentUa": ["gptbot", …],                // AI agents (substring match)
    "agentUaExact": [],                      // whole-UA match
    "signatureAgentDomains": ["chatgpt.com"],// matched inside the Signature-Agent header
    "botLikePattern": "bot\\b|crawl|…",      // regular expression, case-insensitive
    "humanPageVeto": {                       // optional
      "exact":    [["<ua>", "human" | "agent" | "question"]],
      "contains": [["<needle>", "human" | "agent" | "question"]],
      "botLikePattern": "bot\\b|crawl|…"
    }
  },
  "twins": {                      // agent versions of pages
    "enabled": true,              // explicit markdown URLs (/pricing.md)
    "negotiate": true,            // agent version at the normal page URL
    "suffix": ".md",
    "includePaths": [],           // path prefixes; empty = all
    "excludePaths": [],           // path prefixes
    "questionParams": []          // query parameters that carry a visitor's question
  },
  "artifacts": [                  // files Dedica manages on the site's domain
    { "path": "/llms.txt", "action": "proxy", "contentType": "text/plain; charset=utf-8", "version": "…" }
  ],
  "serve": { "baseUrl": "https://api.getdedica.com/api/v1/middleware/serve/", "version": "…" },
  "proxies": [                    // paths forwarded to Dedica, per method
    { "path": "/mcp", "targets": { "POST": "https://api.getdedica.com/…", "GET": "https://…" } }
  ],
  "access": {                     // Agent Access; optional
    "enforce": false,
    "impersonators": "flag",      // "flag" | "block"
    "blockedAgentUa": [], "blockedAgentUaExact": [],
    "blockedServeHumanUa": [], "blockedServeHumanUaExact": [],
    "blockedAgentKeys": [],
    "routes": [ { "id": "…", "kind": "exact" | "prefix", "path": "/private", "action": "block" | "passthrough" } ],
    "verification": {
      "maxAgeSeconds": 604800,
      "claims": [["<needle>", "<agent key>"]],
      "claimsExact": [["<whole ua>", "<agent key>"]],
      "agentIpSets": { "<agent key>": ["<set id>"] },
      "ipSets": { "<set id>": { "cidrs": ["66.249.64.0/19", …], "fetchedAt": "<ISO time>" } },
      "signatureAgents": [
        { "signatureAgent": "chatgpt.com", "agents": ["<agent key>"], "fetchedAt": "<ISO time>",
          "keys": [ { "kid": "…", "x": "<Ed25519 public key, base64url>", "nbf": 1767225600, "exp": null } ] }
          // nbf / exp: Unix seconds; null or absent = no limit
      ]
    }
  }
}
```

#### 3.2.4 Validation

The policy is **rejected as a whole** (treated like no policy, section 3.2.1) when `schemaVersion` is not `1`, `mode`
is neither `report` nor `autopilot`, or `detection` or `twins` is not an object.

Otherwise each part is cleaned, never guessed:

| Part | Rule |
|---|---|
| Any list of strings | Entries that aren't non-empty strings are dropped. |
| `ttlSeconds` | Not a number: 30. Clamped to 5–300. |
| `botLikePattern` (both) | An invalid expression never matches. |
| `humanPageVeto` | Pairs whose action isn't `human`, `agent` or `question`, or whose needle is empty, are dropped. Missing: no veto. |
| `twins.suffix` | Must be `.` followed by 1–16 letters or digits. Otherwise explicit markdown URLs are off, and `.md` is used wherever else the suffix matters (route rules, 5.3). |
| `twins.enabled`, `twins.negotiate` | On only when exactly `true`. |
| `twins.includePaths`, `twins.excludePaths` | Entries not starting with `/` are dropped. |
| `artifacts` | Entries without a `path` starting with `/` are dropped. Missing `action`: `proxy`. Unknown `action`: `passthrough`. Missing `contentType`: `text/plain; charset=utf-8`. |
| `serve` | Dropped unless `baseUrl` is a valid absolute URL and `version` is a string. Without `serve`, nothing is ever fetched from the serve endpoint. |
| `proxies` | Entries without a string `path` or an object `targets` are dropped; non-string targets are dropped. A path is only used if it is `/` followed by at least one character with no `?`, `#` or whitespace. |
| `access` | Missing or not an object: no Agent Access (nothing blocked, no verdicts). `enforce` is on only when exactly `true`. `impersonators` is `block` only when exactly `"block"`, otherwise `flag`. |
| `access.routes` | A rule is skipped unless `kind` is `exact`/`prefix`, `action` is `block`/`passthrough`, and `path` is `/` followed by no `?`, `#` or whitespace. |
| `access.verification.claims`, `claimsExact` | Pairs are dropped unless both elements are non-empty strings. |
| `fetchedAt` (IP sets, signing agents) | A string that isn't a readable date is kept, but the data is never fresh (4.7). |
| `access.verification` | Dropped (no verdicts, no impersonators) unless `maxAgeSeconds` is a positive number. IP sets without a string `fetchedAt`, signing agents without a string `signatureAgent`, string `fetchedAt` and a `keys` list, and keys without string `kid` and `x` are dropped. `signatureAgent` is compared lowercased. |

### 3.3 Serving content (`serve`)

Used for artifacts, explicit markdown URLs and the agent version of a page (section 6).

**Request:** `GET` to `serve.baseUrl` + the path (leading slash removed, repeated slashes collapsed). Redirects are not
followed. `serve.baseUrl` is used as the policy gives it: unlike proxy targets, it isn't restricted to Dedica's origin
or to `https`, and the token is sent to it.

| What is served | Path sent | Query string sent | `x-dedica-category` | Shared |
|---|---|---|---|---|
| Artifact | the artifact's path | none | `public` | yes |
| Explicit markdown URL (`/pricing.md`) | the requested path, suffix included | the visitor's | `public` | yes, unless the query contains any `questionParams` key |
| Agent version of a page (`/pricing`) | the requested path | the visitor's | `eligible` | no |

Headers sent, besides the common ones:

| Header | Value |
|---|---|
| `user-agent` | the visitor's, unchanged (empty if none) |
| `accept` | the visitor's (empty if none) |
| `x-dedica-version` | `v1:` + the artifact's `version`, else `serve.version` |
| `x-dedica-category` | as above |
| `if-none-match`, `if-modified-since` | the visitor's, only when shared and at most 8192 characters |

No cookies, credentials or other visitor headers are sent.

**Unsafe paths are never sent.** If the path, after percent-decoding each segment, contains a `.` or `..` segment or
an encoded `/` or `\`, or would resolve outside `serve.baseUrl`, Dedica isn't asked and the origin answers.

**How Dedica's answer is used:**

| Dedica answers | Result |
|---|---|
| Header `x-dedica-content-fallback: origin` (any status) | The origin answers. No back-off. |
| 200 or 428 | Served to the visitor with Dedica's status. |
| 304 | Served (no body) when shared; otherwise the origin answers. |
| 404 or another status not listed | The origin answers. No back-off. |
| 401, 403 or 5xx | The origin answers, and serving backs off. |
| Network error, time limit reached, body over 8 MiB or too slow | The origin answers, and serving backs off. |

**Back-off:** for 15 s no serve requests are made (the origin answers instead), and every serve request still waiting
on Dedica in that instance is abandoned at once, each falling back to the origin. Back-off is cleared when the policy's
`serve.baseUrl` changes. Back-off does not apply to proxied paths.

**Time limits:** 10 s (1.5 s for the agent version of a page), applied both to Dedica starting to answer and to
reading the body.

**Response sent to the visitor:**

| Header | Value |
|---|---|
| `content-type` | Dedica's; if absent, the artifact's `contentType`, or `text/plain; charset=utf-8` for markdown |
| `x-dedica-served` | `1` |
| `cache-control` | shared and status 200/304: Dedica's `cache-control`, or `no-store` if it sent none. Otherwise `private, no-store`. |
| `vary` | `accept, accept-encoding, user-agent, sec-fetch-mode, sec-fetch-dest` |
| `etag`, `last-modified`, `age`, `date`, `expires` | Dedica's, only when shared and status 200/304 |

No other header from Dedica is passed on. A `HEAD` request gets the same status and headers with no body.

### 3.4 Proxied paths (`proxies`, e.g. `/ask`, `/mcp`)

Only in `autopilot`. A request is proxied when its path equals a `proxies` entry's `path` (trailing slashes ignored on
both sides, case-sensitive) and the entry has a target for the request's method (e.g. `GET`, `POST`). If several
entries have the same path, only the first counts.

**Not proxied (handling continues at section 6, step 6c):**

- the target URL's origin isn't `DEDICA_QUERY_ORIGIN` (or, when unset, `DEDICA_API_URL`'s origin);
- the target, or the allowed origin, isn't `https` (plain `http` is allowed only for `localhost`, `*.localhost` and
  `127.0.0.1`);
- the target contains a username, password or fragment;
- the visitor's query string is over 32,768 characters, or its body over 32,768 bytes;
- the forwarded visitor headers (names plus values) total over 16,384 characters;
- Dedica can't be reached, or answers with `x-dedica-content-fallback: origin`.

In each case the origin still receives the complete original request, body included.

These conditions are checked only after the block and `passthrough` checks of section 6, step 6b, which need nothing
more than a listed path and method.

**Request to Dedica:** same method, to the target URL with its query string replaced by the visitor's, with the
visitor's body. Redirects are not followed. Headers: the common ones plus only these from the visitor, if present:
`accept`, `content-type`, `origin`, `user-agent`, `sec-fetch-mode`, `sec-fetch-dest`, `mcp-protocol-version`,
`mcp-session-id`, `mcp-method`, `mcp-name`, `last-event-id`, and any `mcp-param-*`.

**Response to the visitor:** Dedica's status, whatever it is (errors included), with its body streamed as it arrives
(server-sent events work). Headers:

| Header | Value |
|---|---|
| `cache-control` | `private, no-store` |
| `x-dedica-served` | `1` |
| `x-accel-buffering` | `no` |
| `content-type`, `retry-after`, `allow`, `mcp-protocol-version`, `mcp-session-id`, `vary` | Dedica's, when present |

No other header from Dedica is passed on, `Location` included: a redirect from Dedica reaches the visitor without
it.

The whole exchange, streaming included, is cut off after 50 s.

### 3.5 Heartbeat

Every 5 minutes: `POST /api/v1/middleware/heartbeat/`, `content-type: application/json`, body
`{"middleware":"cloudflare-worker","version":"1.4.0"}`, time limit 5 s. A failure is only logged. Skipped when the
worker is disabled or not configured. Policy requests also tell Dedica the worker is live.

### 3.6 Traffic events

`POST /api/v1/middleware/events/`, `content-type: application/x-ndjson`, header `x-dedica-batch-id: <random UUID>`,
body: one JSON event per line (section 8), time limit 5 s. Dedica is expected to answer `202` with
`{"accepted": n, "rejected": n, "errors": …}`.

---

## 4. Recognising clients

All lists and patterns come from the policy's `detection`.

### 4.1 Classification

A request is classified by the first rule that applies:

1. UA equals an entry of `traditionalBotsExact` → **search engine** (matched: the UA).
2. UA equals an entry of `agentUaExact` → **AI agent** (matched: the UA).
3. The longest needle from `traditionalBots` and `agentUa` together that the UA contains decides: **search engine**
   or **AI agent** (matched: the needle). On equal length a `traditionalBots` needle wins. So `applebot-extended` can
   be an AI agent while `applebot` is a search engine.
4. The lowercased `Signature-Agent` header contains a `signatureAgentDomains` entry → **signed agent** (matched: the
   domain). The signature itself is not checked here.
5. The UA is non-empty, the request has no `Sec-Fetch-Mode` header, and the UA matches `botLikePattern` →
   **automated client**.
6. Otherwise → **unknown** (most likely a person).

Rules 1–3 apply only to a non-empty UA. The recognised signing domain (rule 4's test) is recorded whatever rule decided.

A **search engine** below means a UA that equals a `traditionalBotsExact` entry, or whose longest contained needle
(rule 3) is a `traditionalBots` needle.

A **browser navigation** is a request with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`.

### 4.2 Wants the agent version

A client is treated as an agent wanting the agent version when it is:

- an **AI agent** (rules 2–3), unless it is a browser navigation with no recognised signing domain; or
- a **signed agent** (rule 4); or
- an **automated client** (rule 5).

Clients classified (4.1) as search engines or unknown never are. One overlap exists: a UA equal to an
`agentUaExact` entry whose longest needle is a `traditionalBots` needle is classified as an AI agent, yet counts as a
search engine under the definition in 4.1. Every place that serves the agent version or applies a route block also
requires "not a search engine", so such a client never gets either.

### 4.3 Human-page veto

Decides whether a client keeps the normal page even at an explicit markdown URL. Without `humanPageVeto` in the
policy, nobody is vetoed. Otherwise the first `exact` pair whose needle equals the UA, else the first `contains` pair
whose needle the UA contains, gives the action:

| Action | Keeps the normal page |
|---|---|
| `human` | always |
| `agent` | never |
| `question` | unless the request asks a question (4.5) |
| no pair matches | if the UA is non-empty, matches the veto's `botLikePattern`, and the request doesn't ask a question |

### 4.4 Eligible paths

A path is eligible for an agent version unless it falls under an `excludePaths` entry, and, when `includePaths` is
non-empty, only if it falls under one of them. A path falls under an entry when it equals it or starts with it
followed by `/` (an entry ending in `/` matches anything starting with it).

### 4.5 A question

A request asks a question when the policy declares `questionParams` and either one of them has a non-blank value in
the query string, or the path contains `~~` followed by at least one character.

### 4.6 A page read

A request at a normal page URL may get the agent version only if it looks like a page read. It does not if any of
these hold:

- the path ends in `.js`, `.mjs`, `.css`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.ttf`,
  `.otf`, `.eot`, `.map`, `.webp`, `.avif`, `.mp4`, `.webm`, `.mp3`, `.wav` or `.pdf` (any case);
- it has an `Authorization`, `Cookie`, `Upgrade`, `Range` or `X-Requested-With` header;
- it has a `Sec-Fetch-Dest` other than `document`, `iframe` or `frame`;
- its `Accept` mentions `json` and mentions neither `text/html` nor `text/markdown`.

### 4.7 Identity verdicts (Agent Access)

Worked out only when the policy has `access.verification`, in every mode. The client IP (`CF-Connecting-IP`) is used
for this check and, hashed, for the visitor pseudonym (8.2). The IP itself is never sent anywhere.

The UA **names a bot** when it equals a `claimsExact` entry, else when it contains a `claims` needle (the first match
in the order Dedica sends). That gives the bot's agent key.

| Verdict | When | Agent reported |
|---|---|---|
| `verified` (signed) | A valid Web Bot Auth signature (below) | the named bot if the signer lists it, else the signer's first agent (none if it lists none) |
| `verified` | The UA names a bot, and the client IP is in one of that bot's fresh IP sets | the named bot |
| `impersonator` | The UA names a bot that has at least one fresh IP set, and the client IP is in none of them | the named bot |
| `claimed` | The UA names a bot, but it has no fresh IP set, or there is no valid client IP | the named bot |
| `unknown` | Names no bot, but classification (4.1) isn't **unknown** | none |
| no verdict | Names no bot and classification is **unknown** (a person) | — |

Data is **fresh** when its `fetchedAt` is no more than `maxAgeSeconds` old. IPv4, IPv6 and IPv4-mapped IPv6
addresses are supported; malformed CIDRs are ignored. An error while checking signatures counts as "no valid
signature", and the UA and IP checks still run. Any other error while working out a verdict means no verdict.

**A valid Web Bot Auth signature** (RFC 9421, Ed25519) needs `Signature-Agent`, `Signature-Input` and `Signature`
headers, and at least one signature in them that:

- has `tag="web-bot-auth"`, and `alg` absent or `ed25519`;
- has both `created` and `expires`; `expires` is in the future and `created` no more than 60 s in the future;
- covers `@authority` and `signature-agent`, and uses no component parameter other than `key`;
- names a signing agent whose host equals a fresh `signatureAgents` entry. The signing agent is read from
  `Signature-Agent`: a single value is used as is. For a dictionary, if the signature covers `signature-agent` with a
  `key`, the member with that key is used (none if it is missing). Otherwise the member with the signature's label
  is used, else the only member;
- uses a `keyid` matching one of that entry's keys, currently within the key's `nbf`/`exp`;
- has its value in the `Signature` header under the same label, as `:<base64>:`;
- verifies against that key.

---

## 5. Agent Access rules

### 5.1 When they apply

Only when the policy is in `autopilot` and `access.enforce` is `true`. Otherwise nothing is blocked and route rules
are ignored (verdicts are still reported).

### 5.2 Block rules

Checked in this order; the first that applies blocks the request:

| # | Blocks | `block_rule` |
|---|---|---|
| 1 | `impersonators` is `block`, and the verdict is `impersonator` | `impersonator` |
| 2 | The UA equals a `blockedServeHumanUaExact` entry or contains a `blockedServeHumanUa` needle (search engines, previews, monitors blocked by name) | `serve_human` |
| 3 | The client is not a search engine, the request is not a browser navigation, and the UA equals a `blockedAgentUaExact` entry or contains a `blockedAgentUa` needle | `crawler` |
| 4 | `blockedAgentKeys` is non-empty, the request has a `Signature-Agent` header, its verdict is signed-verified, and the verified agent is in `blockedAgentKeys` | `signature` |
| 5 | The route rule for the path (5.3) is `block`, the client is not a search engine, and it wants the agent version (4.2) | `route` |

Rules 1–2 and 4 apply whatever the request looks like. No header or user agent exempts a request.

### 5.3 Route rules

Paths are compared after collapsing repeated slashes and dropping a trailing slash, on both sides; comparison is
case-sensitive.

- `exact` matches that path only. `prefix` matches the path and everything under it (`/docs` matches `/docs` and
  `/docs/a`, not `/docsx`); a `prefix` of `/` matches everything.
- An `exact` match beats any `prefix`; a longer `prefix` beats a shorter one; on a tie, the first rule wins.
- The request's own path is looked up first. If no rule matches it and the path ends with the twins suffix, the page
  it is the version of is looked up (`/pricing.md` → `/pricing`; `/.md` → `/`).

`block`: see 5.2 rule 5. `passthrough`: the origin answers the path, with no agent version, no explicit markdown
version and no proxying. Rules 1–4 of 5.2 still apply on a `passthrough` path, and artifacts (section 6, step 6e)
are still answered.

---

## 6. How each request is handled

Steps run in order; the first that answers ends handling. "Reported as X" means a traffic event with outcome `X` is
recorded if the request is reportable (section 8.1).

**1. Status check.** `GET /__dedica/status` → `200` JSON, `cache-control: no-store`, always (even disabled or not
configured), no call to Dedica, not reported:

```json
{ "configured": true, "disabled": false, "siteId": "<site id or null>", "mode": "autopilot", "version": "1.4.0" }
```

`mode` is the mode of the policy this instance currently holds, or `null`. `siteId` is `null` when unset or empty.

**2. Kill switch.** Disabled → the origin answers. No call to Dedica, not reported.

**3. Installation proof.** `GET /.well-known/dedica.json` → `200` JSON, `cache-control: no-store`, even when not
configured, no call to Dedica, not reported:

```json
{ "site_id": "<DEDICA_SITE_ID, or null when unset>", "middleware": "cloudflare-worker", "version": "1.4.0" }
```

**4. Not configured** → the origin answers. Not reported.

**5. Dedica's own crawler.** A request with `X-Dedica-Origin-Fetch: 1`:

- `GET` or `HEAD`: the worker obtains the policy (waiting as in 3.2.2) and checks the block rules (5.2). If one
  applies → `403` (section 7), reported as `blocked`. Otherwise the origin answers, not reported.
- Any other method: the origin answers, not reported.

This header never gets Dedica's content: artifacts, markdown versions and proxied paths are all answered by the
origin. The block check runs before anything else here, so a blocked bot sending this header is blocked even on an
artifact path such as `/robots.txt`.

**6. Every other request:**

  a. **Policy.** The worker obtains the policy, waiting if needed (3.2.2). This applies to every request, people
     included.

  b. **Proxied path** (3.4; `autopilot` only). The path and method only have to be listed in `proxies`: the checks
     below run even if the request couldn't actually be proxied (target off the allowed origin, too large, Dedica
     down).
     - a block rule (5.2) applies → `403` JSON (section 7), reported as `blocked`. Nothing is sent to Dedica.
     - the route rule for the path is `passthrough` → the origin answers, reported as `origin`.
     - otherwise the request is proxied, reported as `proxied`.

  c. **Not a `GET` or `HEAD`** → the origin answers, reported as `origin`. (This includes a proxied path that could
     not be proxied, 3.4.)

  d. **No policy, or `report` mode** → the origin answers, reported as `origin`.

  e. **Artifact.** The path equals an artifact's `path` exactly (first match wins). Applies to every visitor, people
     included, and before any block rule, so a blocked crawler can still read `/robots.txt`.

     | `action` | Behaviour | Reported as |
     |---|---|---|
     | `proxy` | Dedica's file (3.3). If Dedica has none, the origin answers. | `artifact`, or `origin` |
     | `fallback` | The origin is asked first. If it has its own file (any 3xx, or a 2xx whose `content-type` isn't HTML), that is the answer. Otherwise Dedica's file if it has one, else the origin's response. | `artifact_origin` (origin's) or `artifact` (Dedica's) |
     | `block` | `403` `Not available to this client.` to everyone | `blocked` |
     | `passthrough` | The origin answers | `origin` |

  f. **Block rules** (5.2) → `403` (section 7), reported as `blocked`.

  g. **`passthrough` route** (5.3) → the origin answers, reported as `origin`.

  h. **Human-page veto** (4.3) keeps the normal page → the origin answers, reported as `human_page`.

  i. **Explicit markdown URL.** `twins.enabled` is on and the path ends with `twins.suffix` (e.g. `/pricing.md`):
     - the page path (suffix removed; `/` if nothing is left) isn't eligible (4.4) → the origin answers, reported as
       `origin`;
     - otherwise Dedica's markdown (3.3, shared unless a question parameter is present), reported as `twin`. If
       Dedica has none, the origin answers, reported as `origin`.

     This is served to anyone who asks for the URL, people and requests with cookies included, unless step h kept
     the normal page.

  j. **Agent version of a page.** All of these must hold:
     - `twins.negotiate` is on;
     - the request is a page read (4.6);
     - the client is not a search engine (4.1);
     - the path is eligible (4.4);
     - the `Accept` header contains `text/markdown`, or the client wants the agent version (4.2).

     Then Dedica's agent version (3.3, private, 1.5 s limit), reported as `negotiated`. If Dedica has none, is too
     slow, or answers 304, the origin answers, reported as `origin`.

  k. Otherwise the origin answers, reported as `origin`.

If anything fails unexpectedly at any step, the origin answers (reported as `origin` when an event can still be
recorded).

### 6.1 By mode

| | `report` | `autopilot` |
|---|---|---|
| Policy fetched, heartbeat, traffic events | yes | yes |
| Identity verdicts in events | yes | yes |
| Proxied paths, artifacts, markdown, agent versions | no, the origin answers everything | yes |
| Agent Access blocking and route rules | no | only with `access.enforce: true` |

---

## 7. Responses the worker creates itself

| Case | Status | Body | Headers |
|---|---|---|---|
| Blocked (5.2) on a page or by step 5 | 403 | `Not available to this client.` | `content-type: text/plain; charset=utf-8`, `cache-control: no-store` |
| Blocked (5.2) on a proxied path | 403 | `{"error":"QUERY_FORBIDDEN","message":"Not available to this client."}` | `content-type: application/json`, `cache-control: no-store` |
| Artifact with action `block` | 403 | `Not available to this client.` | `content-type: text/plain;charset=UTF-8` |
| Status check | 200 | JSON (step 1) | `cache-control: no-store` |
| Installation proof | 200 | JSON (step 3) | `cache-control: no-store` |

Every other response is either the origin's, unchanged, or Dedica's (3.3, 3.4).

---

## 8. Traffic reporting

### 8.1 What is reported

Reported: requests handled in step 6, and requests blocked in step 5, that are **reportable**. Not reported: status
checks, installation proofs, requests while disabled or not configured, and Dedica's crawler when not blocked.

A request is **not** reportable when:

- its last path segment ends in `.js`, `.mjs`, `.css`, `.map`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`,
  `.avif`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`, `.mp4`, `.webm`, `.mp3` or `.wav` (any case);
- it has a `Sec-Fetch-Dest` other than `document`, `iframe` or `frame`;
- its `Sec-Purpose` or `Purpose` header contains `prefetch`.

All methods are reported (e.g. `POST /mcp`).

### 8.2 Event

| Field | Content |
|---|---|
| `id` | random UUID |
| `ts` | ISO time the event was recorded |
| `method` | request method |
| `host` | request host (with port, if any) |
| `path` | request path, at most 2048 characters |
| `query` | only `utm_source`, `utm_medium`, `utm_campaign`, `ref`, `source` (non-empty, each cut to 128 characters) and the policy's `questionParams`, as `?…`; at most 2048 characters, shortening the longest value first. Absent when none. |
| `status` | status of the response sent |
| `latency_ms` | milliseconds from receiving the request to recording the event |
| `outcome` | section 10 |
| `served_by_dedica` | `true` when the response carries `x-dedica-served: 1`, or the outcome is `proxied` or `blocked` |
| `category` | `public` (`artifact`, `artifact_origin`, artifact `block`, `twin`), `eligible` (`negotiated`), otherwise `null` |
| `client` | `null` when the instance holds no policy (see below). Otherwise `kind`: `ai_agent` (AI agent or signed agent, 4.1), `bot` (search engine or automated client), `unknown`; `matched`: what decided it, or `null`; `signature_agent`: the recognised signing domain, or `null`; `verification` and `agent`: the verdict and its agent key (4.7), only when there is a verdict. |
| `block_rule` | the 5.2 rule that blocked it (`impersonator`, `serve_human`, `crawler`, `signature` or `route`); only for Agent Access blocks |
| `user_agent` | the `User-Agent` header as sent, at most 512 characters |
| `referer` | the `Referer`'s origin and path only, at most 2048 characters; absent when missing or invalid |
| `visitor` | daily pseudonym: SHA-256 (hex) of `<client IP>|<User-Agent>|<UTC date YYYY-MM-DD>|<DEDICA_SALT>`. Absent without `DEDICA_SALT` or without a client IP. |
| `country` | `CF-IPCountry` header, else Cloudflare's country, else `null` |
| `headers` | `accept`, `accept-language`, `sec-fetch-mode`, `sec-fetch-dest`, `sec-fetch-site`, when present, each at most 256 characters |
| `mode` | the policy's mode, or `null` |
| `policy_version` | the policy's `version`, or `null` |

`client`, `mode` and `policy_version` use the last policy the instance received, at the time the event is
recorded. This includes a policy too old to be used for handling requests (3.2.2). They are `null` only when the
instance has never received a usable policy, or has dropped it (3.2.1).

Events never contain the client IP, cookies, the full query string, other request headers, or the token.

### 8.3 Delivery

- Events are collected per instance and sent in batches of at most 1000: immediately once 1000 are waiting, otherwise
  5 s after the first event of a batch.
- `429`, `503`, a network error or the time limit → the batch is kept and retried at the next send (which happens
  once more traffic arrives). After such a failure at most 5000 unsent events are kept per instance; the newest
  beyond that are dropped.
- There is no back-off for events. While 1000 or more are waiting (for example after failed sends), every new
  reportable request immediately triggers a send of up to 1000 events, and several sends can run at once.
- Any other non-`202` status → the batch is dropped (logged).
- `202` with `rejected` > 0 → logged.

---

## 9. Time limits and back-off

| Call | Limit | On failure |
|---|---|---|
| Policy | 4 s | Retry after 15 s (5 min for 401/403, 60 s for an unusable policy) |
| Serve (artifacts, markdown URLs) | 10 s, applied to starting the answer and to reading the body | Origin answers; serving off for 15 s |
| Serve (agent version of a page) | 1.5 s, applied to starting the answer and to reading the body | Origin answers; serving off for 15 s |
| Proxied path | 50 s for the whole exchange | Origin answers if Dedica hadn't answered yet |
| Heartbeat | 5 s | Logged |
| Traffic events | 5 s | Batch kept for the next send |

Limits on content: a served body over 8 MiB is refused (origin answers); a proxied request body over
32,768 bytes, a query string over 32,768 characters, or forwarded headers over 16,384 characters, are not proxied
(origin answers).

---

## 10. Outcomes

| Outcome | Meaning |
|---|---|
| `proxied` | A proxied path, answered by Dedica |
| `artifact` | A managed file, served from Dedica |
| `artifact_origin` | A `fallback` file answered by the origin |
| `blocked` | A 403: an artifact with action `block`, or an Agent Access block |
| `twin` | An explicit markdown URL, served from Dedica |
| `negotiated` | The agent version of a normal page URL, served from Dedica |
| `human_page` | The human-page veto kept the normal page; the origin answered |
| `origin` | The origin answered |
