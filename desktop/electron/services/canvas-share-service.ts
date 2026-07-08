import fs from "node:fs/promises";
import path from "node:path";
import {
  isCanvasShareSlug,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
} from "../../../runtime/contracts/canvas-share.js";

/**
 * Main-process side of the canvas-share deep link. Given a
 * `<CANVAS_SHARE_BASE_URL>/c/<slug>` URL, fetch the remote HTML and
 * materialize it into the same `~/.stella/outputs/html/<slug>.html` store the
 * `html` tool writes local canvases to, so the renderer can display it through
 * the identical sandboxed canvas path with no extra privileges.
 *
 * Fetching + writing happen here (privileged, and free of renderer CORS). The
 * slug is validated against the shared grammar before it ever reaches the
 * filesystem, so a share URL can't smuggle path traversal into the target
 * file name.
 */

const MAX_SHARED_CANVAS_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export type SharedCanvasPayload = {
  kind: "canvas-html";
  filePath: string;
  slug: string;
  title: string;
  createdAt: number;
};

/** Configured public base URL for shared canvases (final domain TBD/pending). */
export const readConfiguredCanvasShareBaseUrl = (): string | null =>
  readCanvasShareBaseUrl(process.env.CANVAS_SHARE_BASE_URL);

const titleFromHtml = (html: string, slug: string): string => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.replace(/\s+/g, " ").trim();
  if (raw) return raw;
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char: string) => char.toUpperCase());
};

/**
 * Resolve a canvas-share URL into a file-backed canvas payload, or `null` when
 * the URL is not a valid share link for the configured base, the fetch fails,
 * or the response is empty / oversized.
 */
export const resolveSharedCanvasPayload = async (options: {
  url: string;
  baseUrl: string | null;
  stellaDataDir: string;
}): Promise<SharedCanvasPayload | null> => {
  const { url, baseUrl, stellaDataDir } = options;
  const slug = parseCanvasShareSlug(url, baseUrl);
  if (!slug || !isCanvasShareSlug(slug)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "text/html" },
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_SHARED_CANVAS_BYTES) {
      return null;
    }
    html = buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!html.trim()) return null;

  const htmlDir = path.join(stellaDataDir, "outputs", "html");
  await fs.mkdir(htmlDir, { recursive: true });
  const filePath = path.join(htmlDir, `${slug}.html`);
  await fs.writeFile(filePath, html, "utf8");

  return {
    kind: "canvas-html",
    filePath,
    slug,
    title: titleFromHtml(html, slug),
    createdAt: Date.now(),
  };
};
