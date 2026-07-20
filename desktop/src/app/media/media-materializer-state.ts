import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import type { DisplayPayload } from "@/shared/contracts/display-payload";

const MATERIALIZED_KEY = "stella-media-materialized-jobs";
const MATERIALIZED_PAYLOADS_KEY = "stella-media-materialized-payloads";
const FAILED_NOTIFIED_KEY = "stella-media-failed-notified-jobs";
const MATERIALIZED_CAP = 1000;

const loadFromStorage = (key = MATERIALIZED_KEY): string[] => {
  try {
    const raw = uiState.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[] | { jobIds?: string[] };
    const ids = Array.isArray(parsed) ? parsed : parsed.jobIds;
    return ids ?? [];
  } catch {
    return [];
  }
};

// Enforce MATERIALIZED_CAP in memory (not just on persist). Maps/Sets keep
// insertion order, so deleting the first key evicts the oldest entry, keeping
// the live collection bounded mid-session without changing what gets persisted.
export const capInMemory = (
  collection: Set<string> | Map<string, unknown>,
): void => {
  while (collection.size > MATERIALIZED_CAP) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) break;
    collection.delete(oldest);
  }
};

const persistToStorage = (ids: Set<string>, key = MATERIALIZED_KEY): void => {
  const trimmed = Array.from(ids).slice(-MATERIALIZED_CAP);
  uiState.setItem(key, JSON.stringify(trimmed));
};

const loadPayloadsFromStorage = (): Map<string, DisplayPayload> => {
  const map = new Map<string, DisplayPayload>();
  try {
    const raw = uiState.getItem(MATERIALIZED_PAYLOADS_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return map;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { jobId?: unknown; payload?: unknown };
      if (typeof record.jobId !== "string") continue;
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if ((payload as { kind?: unknown }).kind !== "media") continue;
      map.set(record.jobId, payload as DisplayPayload);
    }
  } catch {
    return new Map();
  }
  return map;
};

const persistPayloadsToStorage = (
  payloads: Map<string, DisplayPayload>,
): void => {
  const entries = Array.from(payloads.entries()).slice(-MATERIALIZED_CAP);
  uiState.setItem(
    MATERIALIZED_PAYLOADS_KEY,
    JSON.stringify(
      entries.map(([jobId, payload]) => ({
        jobId,
        payload,
      })),
    ),
  );
};

// Module-scoped, mutated through `markMediaJobMaterialized` and the
// materializer hook. Sharing the same Set across both means no race window
// where one writer's mark is invisible to the other.
export const materializedJobs: Set<string> = new Set(loadFromStorage());
export const failedNotifiedJobs: Set<string> = new Set(
  loadFromStorage(FAILED_NOTIFIED_KEY),
);

const materializedPayloadsByJobId = loadPayloadsFromStorage();
const materializedPayloadListeners = new Set<() => void>();

export const persistMaterializedJobs = (): void => {
  persistToStorage(materializedJobs);
};

export const persistFailedNotifiedJobs = (): void => {
  persistToStorage(failedNotifiedJobs, FAILED_NOTIFIED_KEY);
};

export const publishMaterializedMediaPayload = (
  payload: DisplayPayload,
): boolean => {
  if (payload.kind === "media" && payload.jobId) {
    const existing = materializedPayloadsByJobId.get(payload.jobId);
    // Transcript replay and the live completion subscription can construct
    // slightly different payloads for the same durable job. Job identity,
    // rather than JSON equality, is the deduplication boundary.
    if (existing) return false;
    materializedPayloadsByJobId.set(payload.jobId, payload);
    // Bound the in-memory payload map, matching the persist-time cap.
    capInMemory(materializedPayloadsByJobId);
    persistPayloadsToStorage(materializedPayloadsByJobId);
  }
  for (const listener of materializedPayloadListeners) listener();
  return true;
};

export const useMaterializedMediaPayload = (
  jobId: string | undefined,
): DisplayPayload | null =>
  useSyncExternalStore(
    (listener) => {
      materializedPayloadListeners.add(listener);
      return () => materializedPayloadListeners.delete(listener);
    },
    () => (jobId ? (materializedPayloadsByJobId.get(jobId) ?? null) : null),
    () => null,
  );

export const useMaterializedMediaPayloadSnapshot = (): ReadonlyMap<
  string,
  DisplayPayload
> =>
  useSyncExternalStore(
    (listener) => {
      materializedPayloadListeners.add(listener);
      return () => materializedPayloadListeners.delete(listener);
    },
    () => materializedPayloadsByJobId,
    () => new Map(),
  );

/**
 * Mark a jobId as already-handled so the materializer skips it. Use this
 * from any UI that materializes its own jobs (e.g. MediaStudio) so we don't
 * double-download or pop the workspace panel over the user's active surface.
 */
export const markMediaJobMaterialized = (jobId: string): void => {
  if (materializedJobs.has(jobId)) return;
  materializedJobs.add(jobId);
  // Bound the in-memory set, matching the persist-time cap.
  capInMemory(materializedJobs);
  persistMaterializedJobs();
};
