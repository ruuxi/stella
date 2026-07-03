import { uiState } from "@/platform/ui-state";

/**
 * Recently used assistant models, persisted across sessions. The sidebar
 * model popover surfaces the freshest few so switching back and forth
 * between a user's usual models is one click.
 *
 * Stored newest-first as override ids (`stella/<mode>`,
 * `openrouter/<model>`, `claude-code/<model>`, …). The empty-string
 * "default" pick is never recorded — the Default row is always present.
 */
const STORAGE_KEY = "stella:recent-models";
const MAX_STORED = 8;

export const readRecentModels = (): string[] => {
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  } catch {
    return [];
  }
};

const writeRecentModels = (next: string[]): void => {
  try {
    uiState.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; ignore storage failures.
  }
};

export const recordRecentModel = (modelId: string): string[] => {
  const trimmed = modelId.trim();
  if (!trimmed) return readRecentModels();
  const next = [
    trimmed,
    ...readRecentModels().filter((entry) => entry !== trimmed),
  ].slice(0, MAX_STORED);
  writeRecentModels(next);
  return next;
};

/**
 * Drop persisted recents that no longer resolve to a selectable model
 * (provider disconnected, catalog entry removed, local model deleted).
 * Returns the surviving list; persists only when something was pruned.
 */
export const pruneRecentModels = (
  isKnownModelId: (modelId: string) => boolean,
): string[] => {
  const current = readRecentModels();
  const next = current.filter(isKnownModelId);
  if (next.length !== current.length) writeRecentModels(next);
  return next;
};

export interface RecentModelRow {
  id: string;
  /**
   * True when the id no longer resolves against the live catalog. Only
   * the pinned current selection renders in this state (so the user sees
   * what's configured); stale non-current recents are dropped outright.
   */
  unavailable?: boolean;
}

/**
 * Pure selection logic for the popover's Recent section: the current
 * selection first (kept visible even when stale, flagged unavailable),
 * then the freshest known recents, minus ids the caller already renders
 * (Stella presets) and duplicates.
 */
export const buildRecentModelRows = (args: {
  currentId: string;
  recentIds: readonly string[];
  excludeIds: ReadonlySet<string>;
  isKnownModelId: (modelId: string) => boolean;
  limit?: number;
}): RecentModelRow[] => {
  const { currentId, recentIds, excludeIds, isKnownModelId } = args;
  const limit = args.limit ?? 4;
  const rows: RecentModelRow[] = [];
  const seen = new Set<string>();
  const push = (id: string, unavailable: boolean) => {
    if (!id || excludeIds.has(id) || seen.has(id)) return;
    seen.add(id);
    rows.push(unavailable ? { id, unavailable } : { id });
  };
  if (currentId) push(currentId, !isKnownModelId(currentId));
  for (const id of recentIds) {
    if (rows.length >= limit) break;
    if (!isKnownModelId(id)) continue;
    push(id, false);
  }
  return rows.slice(0, limit);
};
