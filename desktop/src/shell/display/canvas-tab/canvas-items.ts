/**
 * Module-scoped store of HTML canvases the orchestrator's `html` tool has
 * produced this session.
 *
 * Mirrors `generatedMediaItems` in `payload-to-tab-spec.ts`: the Canvas tab
 * has a single stable id and re-renders against the live items list whenever
 * a new `canvas-html` payload arrives. The hero shows the most-recently-added
 * canvas; the bottom rail navigates between siblings.
 *
 * The files live under `state/outputs/html/`; this store keeps a small
 * persisted index so the Canvas tab survives renderer and desktop restarts.
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
const STORAGE_KEY = "stella-display-canvas-html-items";
const REMOVED_KEY = "stella-display-canvas-html-removed";
const MAX_ITEMS = 200;

// Cached snapshot reference for `useSyncExternalStore`. The contract is
// that `getSnapshot` must return the same reference between mutations,
// otherwise React believes the store is constantly changing and may
// re-render in a loop. We refresh this only when the underlying items
// list mutates.
let snapshot: ReadonlyArray<CanvasHtmlItem> = [];

const refreshSnapshot = () => {
  snapshot = items.slice();
};

const readPersistedItems = (): CanvasHtmlItem[] => {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is CanvasHtmlItem => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Partial<CanvasHtmlItem>;
        return (
          typeof record.id === "string" &&
          typeof record.filePath === "string" &&
          typeof record.title === "string" &&
          typeof record.createdAt === "number"
        );
      })
      .slice(-MAX_ITEMS);
  } catch {
    return [];
  }
};

const persistItems = (): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
  } catch {
    // Best effort only; disk files remain the source of truth.
  }
};

const readRemovedPaths = (): Set<string> => {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(REMOVED_KEY) || "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((path): path is string => typeof path === "string"),
    );
  } catch {
    return new Set();
  }
};

const removedPaths = readRemovedPaths();

const persistRemovedPaths = (): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify(Array.from(removedPaths)));
  } catch {
    // Best effort; removal is a UI preference, not data loss protection.
  }
};

const emit = () => {
  refreshSnapshot();
  persistItems();
  for (const listener of listeners) listener();
};

const seedItem = (item: CanvasHtmlItem): void => {
  if (removedPaths.has(item.filePath)) return;
  if (itemsByPath.has(item.filePath)) return;
  items.push(item);
  itemsByPath.set(item.filePath, item);
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
  removedPaths.delete(payload.filePath);
  persistRemovedPaths();
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
  removedPaths.add(filePath);
  persistRemovedPaths();
  emit();
  return snapshot;
};

export const getCanvasHtmlItems = (): ReadonlyArray<CanvasHtmlItem> => snapshot;

let historyLoadStarted = false;

export const loadCanvasHtmlHistory = async (): Promise<void> => {
  if (historyLoadStarted) return;
  historyLoadStarted = true;
  const listCanvasHtml = window.electronAPI?.display?.listCanvasHtml;
  if (typeof listCanvasHtml !== "function") return;

  try {
    const discovered = await listCanvasHtml();
    let changed = false;
    for (const entry of discovered) {
      if (itemsByPath.has(entry.filePath)) continue;
      seedItem({
        id: entry.filePath,
        filePath: entry.filePath,
        title: entry.title,
        slug: entry.slug,
        createdAt: entry.createdAt,
      });
      changed = true;
    }
    if (changed) emit();
  } catch {
    // Keep the tab usable even if filesystem enumeration is unavailable.
  }
};

export const subscribeCanvasHtmlItems = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

for (const item of readPersistedItems()) {
  seedItem(item);
}
refreshSnapshot();
