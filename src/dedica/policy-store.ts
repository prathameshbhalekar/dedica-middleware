/**
 * The site's policy, fetched from Dedica and cached for a short while (ported from ref.js).
 *
 * - Fresh for `ttlSeconds` (default 30s). After that it is refreshed in the background while the old
 *   one is still used for up to 30s more.
 * - If Dedica is unreachable, a policy that enables serving is kept for at most 15 minutes after its
 *   last successful refresh; otherwise only for the 30s grace. Then the worker passes everything through.
 * - Failures back off (15s; 60s for an unknown schema; 5 min for a rejected token) so a broken
 *   Dedica is never hammered. Only one refresh runs at a time per isolate.
 */

import { POLICY_TIMEOUT_MS, SCHEMA_MAJOR, dedicaInit, dedicaUrl } from "../env";
import type { Ctx, Env, FetchFn, Policy } from "../types";
import { DEFAULT_TTL_S, sanitizePolicy } from "./policy-schema";

export const POLICY_FAILURE_GRACE_MS = 30_000;
export const POLICY_OUTAGE_MAX_MS = 15 * 60_000;

export class PolicyStore {
  policy: Policy | null = null;
  private expiry = 0;
  private fetchedAt = 0;
  private backoffUntil = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  private async performRefresh(env: Env): Promise<void> {
    if (this.now() < this.backoffUntil) return;
    try {
      const res = await this.fetchFn(dedicaUrl(env, "policy"), dedicaInit(env, POLICY_TIMEOUT_MS, { headers: { accept: "application/json" } }));

      if (res.status === 401 || res.status === 403) {
        this.policy = null;
        console.log(`[dedica] policy ${res.status}: check DEDICA_MIDDLEWARE_TOKEN (rotated or wrong?)`);
        this.backoffUntil = this.now() + 300_000;
        return;
      }
      if (!res.ok) {
        // A definite client error drops the policy; a server error or rate limit keeps the old one.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) this.policy = null;
        console.log(`[dedica] policy ${res.status}`);
        this.backoffUntil = this.now() + 15_000;
        return;
      }

      const raw = (await res.json()) as { schemaVersion?: unknown } | null;
      if (raw?.schemaVersion !== SCHEMA_MAJOR) {
        this.policy = null;
        console.log(`[dedica] policy schemaVersion ${raw?.schemaVersion} != ${SCHEMA_MAJOR}; serving nothing`);
        this.backoffUntil = this.now() + 60_000;
        return;
      }
      const next = sanitizePolicy(raw);
      if (!next) {
        this.policy = null;
        console.log("[dedica] policy malformed (mode, detection or twins); serving nothing");
        this.backoffUntil = this.now() + 60_000;
        return;
      }

      this.policy = next;
      this.fetchedAt = this.now();
      this.expiry = this.now() + (next.ttlSeconds ?? DEFAULT_TTL_S) * 1000;
      this.backoffUntil = 0;
    } catch (err) {
      console.log(`[dedica] policy request failed: ${err}`);
      this.backoffUntil = this.now() + 15_000;
    }
  }

  refresh(env: Env): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh(env).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The last policy, if it may still be used during an outage. */
  retained(): Policy | null {
    if (!this.policy) return null;
    const deadline = this.policy.serve ? this.fetchedAt + POLICY_OUTAGE_MAX_MS : this.expiry + POLICY_FAILURE_GRACE_MS;
    return this.now() < deadline ? this.policy : null;
  }

  /**
   * The policy to use for this request. A fresh or recently expired one is returned at once (refreshed in the
   * background); a missing one is waited for (one fetch, shared by every request waiting on it).
   */
  async get(env: Env, ctx: Ctx): Promise<Policy | null> {
    const now = this.now();
    if (this.policy && now < this.expiry) return this.policy;
    const pending = this.refresh(env);
    ctx.waitUntil(pending);
    if (this.policy && now < this.expiry + POLICY_FAILURE_GRACE_MS) return this.policy;
    await pending;
    return this.retained();
  }
}
