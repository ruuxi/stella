/**
 * Module-scoped store of HTML canvases the orchestrator's `html` tool has
 * produced this session.
 *
 * Mirrors `generatedMediaItems` in `payload-to-tab-spec.ts`: the Canvas tab
 * has a single stable id and re-renders against the live items list whenever
 * a new `canvas-html` payload arrives. The hero shows the most-recently-added
 * canvas; the bottom rail navigates between siblings.
 *
 * Persistence beyond the current renderer session is intentionally out of
 * scope for this first cut — the files themselves live under
 * `state/outputs/html/` and can be enumerated later if we want history to
 * survive reloads.
 */

import type { DisplayPayload } from "@/shared/contracts/display-payload";

export type CanvasHtmlItem = {
  id: string;
  filePath: string;
  title: string;
  slug?: string;
  createdAt: number;
};

const items: CanvasHtmlItem[] = [];
const itemsByPath = new Map<string, CanvasHtmlItem>();
const listeners = new Set<() => void>();

// Cached snapshot reference for `useSyncExternalStore`. The contract is
// that `getSnapshot` must return the same reference between mutations,
// otherwise React believes the store is constantly changing and may
// re-render in a loop. We refresh this only when the underlying items
// list mutates.
let snapshot: ReadonlyArray<CanvasHtmlItem> = [];

const refreshSnapshot = () => {
  snapshot = items.slice();
};

const emit = () => {
  refreshSnapshot();
  for (const listener of listeners) listener();
};

const titleFromPayload = (
  payload: Extract<DisplayPayload, { kind: "canvas-html" }>,
): string => {
  if (payload.title && payload.title.trim().length > 0) return payload.title;
  return payload.filePath.split(/[\\/]/).pop() ?? "Canvas";
};

/** Add or refresh a canvas item; returns the up-to-date snapshot. */
export const addCanvasHtmlItem = (
  payload: Extract<DisplayPayload, { kind: "canvas-html" }>,
): ReadonlyArray<CanvasHtmlItem> => {
  const next: CanvasHtmlItem = {
    id: payload.filePath,
    filePath: payload.filePath,
    title: titleFromPayload(payload),
    createdAt: payload.createdAt,
    ...(payload.slug ? { slug: payload.slug } : {}),
  };
  const existing = itemsByPath.get(payload.filePath);
  if (existing) {
    // Mutate in-place so the existing tile keeps its rail position and
    // we still bump createdAt (used as the iframe refresh key).
    existing.title = next.title;
    existing.createdAt = next.createdAt;
    if (next.slug) existing.slug = next.slug;
  } else {
    items.push(next);
    itemsByPath.set(payload.filePath, next);
  }
  emit();
  return snapshot;
};

export const removeCanvasHtmlItem = (
  filePath: string,
): ReadonlyArray<CanvasHtmlItem> => {
  const idx = items.findIndex((item) => item.filePath === filePath);
  if (idx === -1) return snapshot;
  items.splice(idx, 1);
  itemsByPath.delete(filePath);
  emit();
  return snapshot;
};

export const getCanvasHtmlItems = (): ReadonlyArray<CanvasHtmlItem> => snapshot;

export const subscribeCanvasHtmlItems = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
