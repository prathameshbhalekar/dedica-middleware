/**
 * What kind of request this is, from its path and headers alone: a static file, a page read, a path the policy
 * allows an agent version for. Nothing here depends on who the client is (see agents/).
 */

import type { Twins } from "./types";

/** Scripts, styles, images, fonts and media: never a page, never reported. */
const STATIC_EXTENSIONS = new Set([
  "js", "mjs", "css", "map", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "mp3", "wav",
]); // prettier-ignore

/** The lowercased extension of the last path segment (`/a/b.JS` -> `js`), or "". */
function extension(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  return dot > pathname.lastIndexOf("/") ? pathname.slice(dot + 1).toLowerCase() : "";
}

export function isStaticFile(pathname: string): boolean {
  return STATIC_EXTENSIONS.has(extension(pathname));
}

const PAGE_DESTINATIONS = new Set(["document", "iframe", "frame"]);

/** False for a browser's sub-request (a script, an image, a `fetch()`); true without fetch metadata. */
export function isPageDestination(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  return dest === null || PAGE_DESTINATIONS.has(dest);
}

/** Headers that mark an API call, a session, a partial download or a protocol switch: never a page read. */
const NOT_A_PAGE_HEADERS = ["authorization", "cookie", "upgrade", "range", "x-requested-with"];

/**
 * Whether a request at a normal URL may get Dedica's agent version at all (SPEC 4.6). Anything that looks like an
 * API call or a page's sub-request always gets the origin's answer, without asking Dedica: a static file or a PDF, a
 * request carrying credentials, a cookie, a range or an upgrade, a browser's non-page fetch, or an `Accept` that asks
 * for JSON rather than a page.
 */
export function isPageRead(headers: Headers, pathname: string): boolean {
  if (isStaticFile(pathname) || extension(pathname) === "pdf") return false;
  if (NOT_A_PAGE_HEADERS.some((name) => headers.has(name))) return false;
  if (!isPageDestination(headers)) return false;
  const accept = (headers.get("accept") ?? "").toLowerCase();
  if (accept.includes("json") && !accept.includes("text/html") && !accept.includes("text/markdown")) return false;
  return true;
}

/** The policy's include/exclude paths for agent versions of pages, by path prefix (SPEC 4.4). */
export function twinEligible(pathname: string, twins: Twins): boolean {
  const matches = (p: string) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`);
  if ((twins.excludePaths ?? []).some(matches)) return false;
  const include = twins.includePaths ?? [];
  return include.length === 0 || include.some(matches);
}
