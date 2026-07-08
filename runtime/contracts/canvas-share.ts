/**
 * Shared grammar + config for the public "canvas share" feature.
 *
 * A published canvas is reachable at `<CANVAS_SHARE_BASE_URL>/c/<slug>`. The
 * base URL is deployment configuration (final domain is TBD/pending) and MUST
 * be read from config — it is never hardcoded here. This module is kept free
 * of electron/node imports so both the desktop main process and the renderer
 * can share it, and so the parsing rules stay directly unit-testable.
 *
 * Backend contract these helpers pair with:
 *   publish({ html, title? }) -> { url, slug, expiresAt }
 *   revoke({ slug })
 *   listMine() -> [{ slug, url, title, createdAt, expiresAt }]
 */

/** Path segment that scopes a single shared canvas under the base URL. */
export const CANVAS_SHARE_PATH_PREFIX = "/c/";

/**
 * Slugs are opaque, URL- and filesystem-safe ids minted by the backend.
 * Constrained here so an incoming URL can't smuggle path traversal or odd
 * characters into the local file we materialize it into.
 */
const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export const isCanvasShareSlug = (value: unknown): value is string =>
  typeof value === "string" && SLUG_PATTERN.test(value);

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/**
 * Normalize a configured base URL. Returns `null` when unset/blank or not an
 * http(s) URL, so callers can render a "domain pending" state instead of
 * guessing a host.
 */
export const readCanvasShareBaseUrl = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = trimTrailingSlashes(value.trim());
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
};

export const canvasSharePathForSlug = (slug: string): string =>
  `${CANVAS_SHARE_PATH_PREFIX}${slug}`;

export const buildCanvasShareUrl = (baseUrl: string, slug: string): string =>
  `${trimTrailingSlashes(baseUrl)}${canvasSharePathForSlug(slug)}`;

/**
 * Extract the slug from a canvas-share URL when it matches
 * `<baseUrl>/c/<slug>` on the same origin. Returns `null` on any mismatch,
 * including when `baseUrl` is not configured. A base URL that itself lives
 * under a sub-path (e.g. `https://host/app`) still scopes `/c/<slug>`
 * correctly.
 */
export const parseCanvasShareSlug = (
  value: string,
  baseUrl: string | null | undefined,
): string | null => {
  const base = readCanvasShareBaseUrl(baseUrl);
  if (!base) return null;
  let target: URL;
  let root: URL;
  try {
    target = new URL(value);
    root = new URL(base);
  } catch {
    return null;
  }
  if (target.origin !== root.origin) return null;
  const rootPath = trimTrailingSlashes(root.pathname);
  const expectedPrefix = `${rootPath}${CANVAS_SHARE_PATH_PREFIX}`;
  if (!target.pathname.startsWith(expectedPrefix)) return null;
  const slug = target.pathname.slice(expectedPrefix.length);
  // A share URL points at exactly one canvas — no nested path segments.
  if (!slug || slug.includes("/")) return null;
  return isCanvasShareSlug(slug) ? slug : null;
};

export const isCanvasShareUrl = (
  value: string,
  baseUrl: string | null | undefined,
): boolean => parseCanvasShareSlug(value, baseUrl) !== null;
