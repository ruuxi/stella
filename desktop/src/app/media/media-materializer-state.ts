import { useSyncExternalStore } from "react";
import type { DisplayPayload } from "@/shared/contracts/display-payload";

const MATERIALIZED_KEY = "stella-media-materialized-jobs";
const MATERIALIZED_PAYLOADS_KEY = "stella-media-materialized-payloads";
const FAILED_NOTIFIED_KEY = "stella-media-failed-notified-jobs";
const MATERIALIZED_CAP = 1000;

const loadFromStorage = (key = MATERIALIZED_KEY): string[] => {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[] | { jobIds?: string[] };
    const ids = Array.isArray(parsed) ? parsed : parsed.jobIds;
    return ids ?? [];
  } catch {
    return [];
  }
};

const persistToStorage = (ids: Set<string>, key = MATERIALIZED_KEY): void => {
  if (typeof localStorage === "undefined") return;
  try {
    const trimmed = Array.from(ids).slice(-MATERIALIZED_CAP);
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    // Best-effort; no-op on quota errors.
  }
};

const loadPayloadsFromStorage = (): Map<string, DisplayPayload> => {
  const map = new Map<string, DisplayPayload>();
  if (typeof localStorage === "undefined") return map;
  try {
    const raw = localStorage.getItem(MATERIALIZED_PAYLOADS_KEY);
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
  if (typeof localStorage === "undefined") return;
  try {
    const entries = Array.from(payloads.entries()).slice(-MATERIALIZED_CAP);
    localStorage.setItem(
      MATERIALIZED_PAYLOADS_KEY,
      JSON.stringify(
        entries.map(([jobId, payload]) => ({
          jobId,
          payload,
        })),
      ),
    );
  } catch {
    // Best-effort; no-op on quota errors.
  }
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

export const publishMaterializedMediaPayload = (payload: DisplayPayload): void => {
  if (payload.kind === "media" && payload.jobId) {
    materializedPayloadsByJobId.set(payload.jobId, payload);
    persistPayloadsToStorage(materializedPayloadsByJobId);
  }
  for (const listener of materializedPayloadListeners) listener();
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
  persistMaterializedJobs();
};
