/**
 * The Files section's index — one newest-first list of every artifact the
 * panel can render, merged from the stores that already own each kind.
 *
 * Entries are keyed by display-tab id, so an entry maps 1:1 onto a viewer
 * spec, and each one carries the `DisplayPayload` that produced it. The
 * payload is what lets the list outlive a launch: the tab registry is
 * in-memory only, so re-opening an entry replays its payload through
 * `openDisplayPayloadTab` instead of hunting for a tab nobody registered yet.
 *
 * Canvas HTML and generated media keep persisted stores of their own and push
 * a projection in through `setFileEntries`, so their tombstones and caps stay
 * in one place. The `artifact` source — markdown, PDFs, office documents,
 * diffs, URLs — has no such store, so this module persists those entries
 * itself with the same cap-and-tombstone shape the canvas store uses.
 */

import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import {
  isDisplayTabPayload,
  type DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import type { DisplayTabKind } from "./types";

/**
 * Which store an entry came from. The Files list needs this to route a
 * removal back to the store that can actually forget the artifact.
 */
export type FileEntrySource = "canvas" | "media" | "artifact";

export type FileEntry = {
  source: FileEntrySource;
  /** Display-tab id — the id `payloadToTabSpec` gives this same artifact. */
  id: string;
  kind: DisplayTabKind;
  title: string;
  filePath?: string;
  createdAt: number;
  payload: DisplayTabPayload;
};

const STORAGE_KEY = "stella-display-artifact-file-entries";
const REMOVED_KEY = "stella-display-artifact-file-entries-removed";
const MAX_ARTIFACT_ENTRIES = 200;

const bySource = new Map<FileEntrySource, ReadonlyArray<FileEntry>>();
const listeners = new Set<() => void>();

// Stable snapshot for `useSyncExternalStore`; refreshed only on mutation.
let snapshot: ReadonlyArray<FileEntry> = [];

/** Newest first, ties broken by id so the order never wobbles on re-render. */
const compareEntries = (a: FileEntry, b: FileEntry): number =>
  b.createdAt - a.createdAt || a.id.localeCompare(b.id);

const emit = (): void => {
  const merged = new Map<string, FileEntry>();
  for (const entries of bySource.values()) {
    for (const entry of entries) {
      const existing = merged.get(entry.id);
      // The same artifact can reach us from two stores (a canvas that was
      // also opened as a plain file, say). Keep the fresher record.
      if (existing && existing.createdAt >= entry.createdAt) continue;
      merged.set(entry.id, entry);
    }
  }
  snapshot = Array.from(merged.values()).sort(compareEntries);
  for (const listener of listeners) listener();
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

const isPersistedEntry = (entry: unknown): entry is FileEntry => {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Partial<FileEntry>;
  return (
    typeof record.id === "string" &&
    typeof record.kind === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    isDisplayTabPayload(record.payload)
  );
};

const removedIds = new Set(
  readJsonArray<unknown>(REMOVED_KEY).filter(
    (id): id is string => typeof id === "string",
  ),
);

const persistRemovedIds = (): void =>
  writeJsonArray(REMOVED_KEY, Array.from(removedIds));

const artifactEntries: FileEntry[] = readJsonArray<unknown>(STORAGE_KEY)
  .filter(isPersistedEntry)
  .filter((entry) => !removedIds.has(entry.id))
  .map((entry) => ({ ...entry, source: "artifact" as const }))
  .slice(-MAX_ARTIFACT_ENTRIES);

const artifactEntriesById = new Map(
  artifactEntries.map((entry) => [entry.id, entry]),
);

const persistArtifactEntries = (): void =>
  writeJsonArray(STORAGE_KEY, artifactEntries.slice(-MAX_ARTIFACT_ENTRIES));

const publishArtifactEntries = (): void => {
  bySource.set("artifact", artifactEntries.slice());
  emit();
};

/**
 * Replace one store's contribution to the index. Canvas and media call this
 * on every mutation with their whole projection; nothing is diffed, because
 * both stores are capped small enough that a rebuild is cheaper than
 * reconciling.
 */
export const setFileEntries = (
  source: FileEntrySource,
  entries: ReadonlyArray<FileEntry>,
): void => {
  bySource.set(source, entries);
  emit();
};

/**
 * Add or refresh an artifact entry — the kinds with no store behind them.
 * Recording an artifact the user previously removed brings it back, matching
 * how a re-rendered canvas clears its tombstone.
 */
export const recordArtifactFileEntry = (
  entry: Omit<FileEntry, "source">,
): void => {
  if (removedIds.delete(entry.id)) persistRemovedIds();
  const next: FileEntry = { ...entry, source: "artifact" };
  const existing = artifactEntriesById.get(entry.id);
  if (existing) {
    const index = artifactEntries.indexOf(existing);
    artifactEntries[index] = next;
  } else {
    artifactEntries.push(next);
  }
  artifactEntriesById.set(entry.id, next);
  persistArtifactEntries();
  publishArtifactEntries();
};

/** Forget an artifact entry, tombstoning it so a stale replay can't revive it. */
export const forgetArtifactFileEntry = (id: string): void => {
  const existing = artifactEntriesById.get(id);
  if (!existing) return;
  artifactEntries.splice(artifactEntries.indexOf(existing), 1);
  artifactEntriesById.delete(id);
  removedIds.add(id);
  persistRemovedIds();
  persistArtifactEntries();
  publishArtifactEntries();
};

export const getFileEntries = (): ReadonlyArray<FileEntry> => snapshot;

export const subscribeFileEntries = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useFileEntries = (): ReadonlyArray<FileEntry> =>
  useSyncExternalStore(subscribeFileEntries, getFileEntries, getFileEntries);

publishArtifactEntries();
