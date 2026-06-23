/**
 * Per-turn web-search image derivation.
 *
 * The `web` tool (search mode) persists its structured hits onto the
 * `tool_result` payload (see `runtime/kernel/tools/defs/web.ts` and the
 * worker spread in `runtime/worker/server.ts`). Each hit may carry an
 * `image`/`favicon` URL supplied by Exa. We surface those as an inline
 * "Results from the web" strip, Claude-style — but only for hits that
 * actually have a thumbnail, since the cards are image-first.
 *
 * The model never sees these URLs (the text result stays clean); this is
 * purely a renderer affordance derived from already-persisted events.
 */

import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { WebSearchResultHit } from "../../../../../runtime/contracts/local-chat.js";

/** Cap so the strip stays a single tidy row regardless of result count. */
const MAX_WEB_SEARCH_IMAGE_CARDS = 4;

export type WebSearchImageHit = {
  title: string;
  url: string;
  image: string;
  favicon?: string;
};

const isHttpUrl = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\//i.test(value.trim());

/**
 * Dedupe key for an image URL: host + path with the query string and hash
 * dropped, lowercased. Collapses the common case of the same asset served
 * at different sizes via query params (e.g. `?w=800` vs `?w=1500`) or with
 * tracking params, without false-merging same-named files across hosts.
 */
const imageDedupeKey = (image: string): string => {
  try {
    const parsed = new URL(image);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return image.toLowerCase();
  }
};

const readResultsArray = (
  payload: Record<string, unknown> | undefined,
): WebSearchResultHit[] | null => {
  if (!payload) return null;
  if (Array.isArray(payload.results)) {
    return payload.results as WebSearchResultHit[];
  }
  const result = payload.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const nested = (result as Record<string, unknown>).results;
    if (Array.isArray(nested)) return nested as WebSearchResultHit[];
  }
  return null;
};

/**
 * Pick the most recent `web` search result on this turn and return its
 * image-bearing hits (deduped by URL, capped). Returns `[]` for turns
 * with no web search or no thumbnailable results.
 */
export const deriveTurnWebSearchResults = (
  events: readonly EventRecord[],
): WebSearchImageHit[] => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "tool_result") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || payload.toolName !== "web") continue;
    if (typeof payload.error === "string" && payload.error) continue;
    if (payload.mode !== undefined && payload.mode !== "search") continue;

    const results = readResultsArray(payload);
    if (!results) continue;

    const seenUrls = new Set<string>();
    const seenImages = new Set<string>();
    const hits: WebSearchImageHit[] = [];
    for (const hit of results) {
      if (!hit || typeof hit !== "object") continue;
      const url = typeof hit.url === "string" ? hit.url.trim() : "";
      const image = typeof hit.image === "string" ? hit.image.trim() : "";
      if (!isHttpUrl(url) || !isHttpUrl(image)) continue;
      const imageKey = imageDedupeKey(image);
      if (seenUrls.has(url) || seenImages.has(imageKey)) continue;
      seenUrls.add(url);
      seenImages.add(imageKey);
      const favicon =
        typeof hit.favicon === "string" && isHttpUrl(hit.favicon)
          ? hit.favicon.trim()
          : undefined;
      hits.push({
        title: typeof hit.title === "string" ? hit.title.trim() : "",
        url,
        image,
        ...(favicon ? { favicon } : {}),
      });
      if (hits.length >= MAX_WEB_SEARCH_IMAGE_CARDS) break;
    }

    // First (most recent) web search on the turn wins; don't merge older
    // searches into the same strip.
    return hits;
  }
  return [];
};
