/**
 * Who a bot really is (Agent Access), worked out at the edge from data in the policy:
 *
 * - `verified`: a valid Web Bot Auth signature (RFC 9421, Ed25519) from a signing agent Dedica knows, or a user agent
 *   naming a bot whose request comes from that bot's published IP ranges.
 * - `impersonator`: a user agent naming a bot whose vendor publishes ranges, from outside all of them.
 * - `claimed`: a user agent naming a bot, with nothing to check it against (no published ranges, ranges too old, or
 *   no client IP). Never treated as suspicious.
 * - `unknown`: an automated client that names no bot Dedica knows.
 *
 * The client IP (`cf-connecting-ip`, set by Cloudflare and not forgeable by the client) is used here only, in memory.
 * It is never reported: events carry only the verdict.
 */

import type { SignatureAgent, Verification } from "../types";

export type Tier = "verified" | "claimed" | "impersonator" | "unknown";

export interface Identity {
  tier: Tier;
  /** The catalog key of the agent named or proven, if any. */
  agent: string | null;
  /** Proven by a signature (as opposed to an IP range). */
  signed: boolean;
}

/** How far a signature's `created`/`expires` may be from our clock. */
export const SIGNATURE_SKEW_S = 60;

// ---------------------------------------------------------------------------------------------------------------
// IP addresses and ranges
// ---------------------------------------------------------------------------------------------------------------

interface Ip {
  v6: boolean;
  value: bigint;
}

interface Cidr {
  v6: boolean;
  value: bigint;
  mask: bigint;
}

function parseV4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(text: string): bigint | null {
  let address = text;
  // An embedded IPv4 tail (`::ffff:192.0.2.1`) becomes two hextets.
  const lastColon = address.lastIndexOf(":");
  if (address.includes(".", lastColon)) {
    const v4 = parseV4(address.slice(lastColon + 1));
    if (v4 === null) return null;
    address = `${address.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** An IPv4 or IPv6 address (brackets and a zone id are ignored), or null. An IPv4-mapped IPv6 address is IPv4. */
export function parseIp(text: string): Ip | null {
  const raw = text.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  if (!raw.includes(":")) {
    const v4 = parseV4(raw);
    return v4 === null ? null : { v6: false, value: v4 };
  }
  const v6 = parseV6(raw);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v6: false, value: v6 & 0xffffffffn };
  return { v6: true, value: v6 };
}

export function parseCidr(text: string): Cidr | null {
  const [address, length, extra] = text.trim().split("/");
  if (extra !== undefined || !address) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const bits = ip.v6 ? 128 : 32;
  const prefix = length === undefined ? bits : /^\d{1,3}$/.test(length) ? Number(length) : -1;
  if (prefix < 0 || prefix > bits) return null;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { v6: ip.v6, value: ip.value & mask, mask };
}

const parsedSets = new WeakMap<object, Cidr[]>();

/** A set's ranges, parsed once per policy. */
function ranges(set: { cidrs: string[] }): Cidr[] {
  let cidrs = parsedSets.get(set);
  if (!cidrs) {
    cidrs = set.cidrs.map(parseCidr).filter((c): c is Cidr => c !== null);
    parsedSets.set(set, cidrs);
  }
  return cidrs;
}

export function inRanges(ip: Ip, cidrs: Cidr[]): boolean {
  return cidrs.some((c) => c.v6 === ip.v6 && (ip.value & c.mask) === c.value);
}

function fresh(fetchedAt: string, v: Verification, now: number): boolean {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now - at <= v.maxAgeSeconds * 1000;
}

// ---------------------------------------------------------------------------------------------------------------
// Claims: which bot a user agent names
// ---------------------------------------------------------------------------------------------------------------

const exactIndex = new WeakMap<Verification, Map<string, string>>();

/** The catalog key of the bot a (lowercased) user agent names, or null. */
export function claimedAgent(v: Verification, ua: string): string | null {
  if (!ua) return null;
  let exact = exactIndex.get(v);
  if (!exact) {
    exact = new Map(v.claimsExact);
    exactIndex.set(v, exact);
  }
  return exact.get(ua) ?? v.claims.find(([needle]) => ua.includes(needle))?.[1] ?? null;
}

/** `verified` or `impersonator` from the client IP, or `claimed` when there is nothing fresh to check against. */
export function ipTier(v: Verification, agent: string, clientIp: string | null, now: number): Tier {
  const sets = (v.agentIpSets[agent] ?? []).map((id) => v.ipSets[id]).filter((s) => s !== undefined && fresh(s.fetchedAt, v, now));
  const ip = clientIp ? parseIp(clientIp) : null;
  if (sets.length === 0 || !ip) return "claimed";
  return sets.some((s) => inRanges(ip, ranges(s))) ? "verified" : "impersonator";
}

// ---------------------------------------------------------------------------------------------------------------
// Web Bot Auth (HTTP Message Signatures, RFC 9421, with Ed25519)
// ---------------------------------------------------------------------------------------------------------------

/** Splits a structured-field list or dictionary on its top-level commas (not inside quotes or parentheses). */
export function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((m) => m.length > 0);
}

/** A structured-field dictionary as `label -> raw member value` (the text after `label=`, exactly as sent). */
export function dictionary(value: string): Map<string, string> {
  const members = new Map<string, string>();
  for (const member of splitTopLevel(value)) {
    const eq = member.indexOf("=");
    if (eq <= 0) continue;
    members.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
  }
  return members;
}

function unquote(text: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim());
  return m ? m[1].replace(/\\(.)/g, "$1") : null;
}

interface Component {
  name: string;
  /** The `;key="..."` parameter: a member of a dictionary header. */
  key?: string;
}

interface SignatureParams {
  components: Component[];
  created?: number;
  expires?: number;
  keyid?: string;
  alg?: string;
  tag?: string;
}

/** `("@authority" "signature-agent";key="sig1");created=1;keyid="k";alg="ed25519"`, or null when malformed. */
export function parseSignatureInput(member: string): SignatureParams | null {
  const m = /^\(([^)]*)\)(.*)$/.exec(member.trim());
  if (!m) return null;
  const components: Component[] = [];
  for (const item of m[1].trim().split(/\s+(?=")/).filter(Boolean)) {
    const cm = /^"([^"]+)"((?:;[a-z0-9*_.-]+(?:=(?:"[^"]*"|[^;]*))?)*)$/i.exec(item.trim());
    if (!cm) return null;
    const key = /;key="([^"]*)"/.exec(cm[2])?.[1];
    if (/;(?!key=)[a-z]/i.test(cm[2])) return null; // `;sf`, `;bs`, `;req`, `;tr`: not supported
    components.push({ name: cm[1].toLowerCase(), key });
  }
  const params: SignatureParams = { components };
  for (const param of m[2].split(";").slice(1)) {
    const [name, raw = ""] = param.split("=");
    const value = raw.trim();
    if (name === "created" || name === "expires") params[name] = /^\d+$/.test(value) ? Number(value) : undefined;
    else if (name === "keyid" || name === "alg" || name === "tag") params[name] = unquote(value) ?? undefined;
  }
  return params;
}

/** The value of one covered component, as RFC 9421 section 2 defines it, or null when it can't be built. */
function componentValue(component: Component, request: Request, url: URL): string | null {
  switch (component.name) {
    case "@method":
      return request.method.toUpperCase();
    case "@authority":
      return url.host.toLowerCase();
    case "@scheme":
      return url.protocol.replace(":", "").toLowerCase();
    case "@target-uri":
      return url.href;
    case "@path":
      return url.pathname || "/";
    case "@query":
      return url.search || "?";
    case "@request-target":
      return `${url.pathname}${url.search}`;
  }
  if (component.name.startsWith("@")) return null;
  const header = request.headers.get(component.name);
  if (header === null) return null;
  if (component.key === undefined) return header.trim().replace(/\s*,\s*/g, ", ");
  return dictionary(header).get(component.key) ?? null;
}

export function signatureBase(params: SignatureParams, rawParams: string, request: Request, url: URL): string | null {
  const lines: string[] = [];
  for (const component of params.components) {
    const value = componentValue(component, request, url);
    if (value === null) return null;
    const id = component.key === undefined ? `"${component.name}"` : `"${component.name}";key="${component.key}"`;
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${rawParams}`);
  return lines.join("\n");
}

function base64urlBytes(text: string): Uint8Array | null {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const importedKeys = new Map<string, Promise<CryptoKey | null>>();

function importKey(x: string): Promise<CryptoKey | null> {
  let key = importedKeys.get(x);
  if (!key) {
    const bytes = base64urlBytes(x);
    key = bytes
      ? crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]).catch(() => null)
      : Promise.resolve(null);
    if (importedKeys.size > 64) importedKeys.clear();
    importedKeys.set(x, key);
  }
  return key;
}

/** The host of a `Signature-Agent` value (`"https://chatgpt.com"`), or null. */
function hostOf(value: string): string | null {
  const raw = (value.split(";")[0] ?? "").trim();
  const text = unquote(raw) ?? raw;
  if (!text) return null;
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The signing agent's host for one signature. `Signature-Agent` is either one string, or a dictionary with a member
 * per signature: the one the signature covers (`"signature-agent";key="x"`), else the one with the signature's own
 * label, else the only one.
 */
function signingHost(header: string, params: SignatureParams, label: string): string | null {
  const text = header.trim();
  if (!/^[a-z*][a-z0-9_.*-]*\s*=/.test(text)) return hostOf(text);
  const members = dictionary(text);
  const covered = params.components.find((c) => c.name === "signature-agent" && c.key !== undefined)?.key;
  const member = covered !== undefined ? members.get(covered) : (members.get(label) ?? (members.size === 1 ? [...members.values()][0] : undefined));
  return member === undefined ? null : hostOf(member);
}

/**
 * The signing agent whose key verifies one of the request's signatures, or null. Every failure (missing or malformed
 * headers, unknown key, expired signature, bad signature, a WebCrypto without Ed25519) is simply "not signed".
 */
export async function verifiedSigner(v: Verification, request: Request, now: number): Promise<SignatureAgent | null> {
  const agentHeader = request.headers.get("signature-agent");
  const inputHeader = request.headers.get("signature-input");
  const signatureHeader = request.headers.get("signature");
  if (!agentHeader || !inputHeader || !signatureHeader) return null;
  const url = new URL(request.url);
  const signatures = dictionary(signatureHeader);
  const seconds = Math.floor(now / 1000);
  for (const [label, rawParams] of dictionary(inputHeader)) {
    const params = parseSignatureInput(rawParams);
    if (!params || params.tag !== "web-bot-auth" || (params.alg !== undefined && params.alg !== "ed25519")) continue;
    // A signature that never expires, or isn't dated, could be replayed forever.
    if (params.created === undefined || params.expires === undefined) continue;
    if (params.expires <= seconds || params.created > seconds + SIGNATURE_SKEW_S) continue;
    // It must cover this site (`@authority`), or one captured elsewhere could be replayed here, and the
    // Signature-Agent header, or anyone could claim to be the signer.
    if (!params.components.some((c) => c.name === "@authority" && c.key === undefined)) continue;
    if (!params.components.some((c) => c.name === "signature-agent")) continue;
    const host = signingHost(agentHeader, params, label);
    const signer = v.signatureAgents.find((s) => s.signatureAgent === host && fresh(s.fetchedAt, v, now));
    if (!signer) continue;
    const key = signer.keys.find((k) => k.kid === params.keyid && (k.nbf == null || k.nbf <= seconds) && (k.exp == null || k.exp > seconds));
    const signature = /^:([A-Za-z0-9+/=]*):$/.exec(signatures.get(label) ?? "")?.[1];
    if (!key || signature === undefined) continue;
    const base = signatureBase(params, rawParams, request, url);
    const cryptoKey = base === null ? null : await importKey(key.x);
    if (!cryptoKey || base === null) continue;
    const signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle
      .verify({ name: "Ed25519" }, cryptoKey, signatureBytes, new TextEncoder().encode(base))
      .catch(() => false);
    if (ok) return signer;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------------------------

/**
 * Who sent this request. `ua` is lowercased; `automated` says whether the worker already took it for a bot (so an
 * unnamed one is `unknown` rather than a person). Null for a person, or when the policy carries no verification data.
 */
export async function identify(
  v: Verification | null,
  request: Request,
  ua: string,
  automated: boolean,
  now: number,
): Promise<Identity | null> {
  if (!v) return null;
  const claimed = claimedAgent(v, ua);
  const signer = await verifiedSigner(v, request, now).catch(() => null);
  if (signer) {
    const agent = claimed && signer.agents.includes(claimed) ? claimed : (signer.agents[0] ?? null);
    return { tier: "verified", agent, signed: true };
  }
  if (claimed) return { tier: ipTier(v, claimed, request.headers.get("cf-connecting-ip"), now), agent: claimed, signed: false };
  return automated ? { tier: "unknown", agent: null, signed: false } : null;
}
