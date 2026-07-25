/**
 * Module-scoped store of HTML canvases the orchestrator's `html` tool has
 * produced. Files live under `~/.stella/outputs/html/` and a small index in
 * the shared UI state store keeps them listed across renderer and desktop
 * restarts; every mutation republishes the list into the Files index, which
 * is what the sidebar actually renders.
 */

import {
  setFileEntries,
  type FileEntry,
} from "@/features/workspace-display/files-index";
import { uiState } from "@/platform/ui-state";
import type { DisplayPayload } from "@/shared/contracts/display-payload";

export type CanvasHtmlItem = {
  id: string;
  filePath: string;
  title: string;
  slug?: string;
  createdAt: number;
};

/** Display-tab id for a canvas, so one file is one Files entry. */
export const canvasDisplayTabId = (filePath: string): string =>
  `canvas:${filePath}`;

const items: CanvasHtmlItem[] = [];
const itemsByPath = new Map<string, CanvasHtmlItem>();
const STORAGE_KEY = "stella-display-canvas-html-items";
const REMOVED_KEY = "stella-display-canvas-html-removed";
const MAX_ITEMS = 200;

// Stable snapshot for `useSyncExternalStore`; refreshed only on mutation.
let snapshot: ReadonlyArray<CanvasHtmlItem> = [];

const toFileEntry = (item: CanvasHtmlItem): FileEntry => ({
  source: "canvas",
  id: canvasDisplayTabId(item.filePath),
  kind: "canvas",
  title: item.title,
  filePath: item.filePath,
  createdAt: item.createdAt,
  payload: {
    kind: "canvas-html",
    filePath: item.filePath,
    title: item.title,
    createdAt: item.createdAt,
    ...(item.slug ? { slug: item.slug } : {}),
  },
});

const refreshSnapshot = () => {
  snapshot = items.slice();
  setFileEntries("canvas", items.map(toFileEntry));
};

const readJsonArray = <T>(key: string): T[] => {
  try {
    const parsed = JSON.parse(uiState.getItem(key) || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const writeJsonArray = <T>(key: string, value: ReadonlyArray<T>): void => {
  uiState.setItem(key, JSON.stringify(value));
};

const isPersistedItem = (entry: unknown): entry is CanvasHtmlItem => {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Partial<CanvasHtmlItem>;
  return (
    typeof record.id === "string" &&
    typeof record.filePath === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number"
  );
};

const readPersistedItems = (): CanvasHtmlItem[] =>
  readJsonArray<unknown>(STORAGE_KEY).filter(isPersistedItem).slice(-MAX_ITEMS);

const persistItems = (): void =>
  writeJsonArray(STORAGE_KEY, items.slice(-MAX_ITEMS));

const removedPaths = new Set(
  readJsonArray<unknown>(REMOVED_KEY).filter(
    (path): path is string => typeof path === "string",
  ),
);

const persistRemovedPaths = (): void =>
  writeJsonArray(REMOVED_KEY, Array.from(removedPaths));

const emit = () => {
  refreshSnapshot();
  persistItems();
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
    // Mutate in-place so the entry keeps its identity and we still bump
    // createdAt (used as the iframe refresh key).
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
    // Keep the list usable even if filesystem enumeration is unavailable.
  }
};

for (const item of readPersistedItems()) {
  seedItem(item);
}
refreshSnapshot();
