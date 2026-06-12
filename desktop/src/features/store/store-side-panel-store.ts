/**
 * Side-panel selection state.
 *
 * The list renders the durable feature snapshot (newest roster features)
 * first, with older roster entries paged in behind the "Show older"
 * affordance. Multi-select state lives here so the user's picks survive
 * remounts.
 */
import { useSyncExternalStore } from "react";
import type {
  SelfModFeatureRosterEntry,
  SelfModFeatureSnapshot,
} from "@/shared/types/electron";

export type StoreSidePanelOlderEntry = SelfModFeatureRosterEntry & {
  commitHashes: string[];
};

type StoreSidePanelState = {
  snapshot: SelfModFeatureSnapshot | null;
  snapshotLoading: boolean;
  /** Selected feature keys — `featureId`, falling back to `name` for stale snapshot rows without one. */
  selectedFeatureKeys: Set<string>;
  /** Roster entries older than the snapshot window, in roster order. */
  olderEntries: StoreSidePanelOlderEntry[];
  /** Total roster size (null until the first roster probe resolves). */
  rosterTotal: number | null;
  olderLoading: boolean;
};

const OLDER_PAGE_SIZE = 20;

const EMPTY: StoreSidePanelState = {
  snapshot: null,
  snapshotLoading: true,
  selectedFeatureKeys: new Set(),
  olderEntries: [],
  rosterTotal: null,
  olderLoading: false,
};

/** Selection identity for a snapshot item or roster entry. */
export const featureKeyOf = (item: {
  featureId?: string;
  name: string;
}): string => item.featureId ?? item.name;

let state: StoreSidePanelState = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: StoreSidePanelState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const toggle = <T>(prev: Set<T>, value: T): Set<T> => {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

export const storeSidePanelStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): StoreSidePanelState {
    return state;
  },
  setSnapshot(snapshot: SelfModFeatureSnapshot | null): void {
    emit({ ...state, snapshot, snapshotLoading: false });
  },
  setSnapshotLoading(loading: boolean): void {
    if (state.snapshotLoading === loading) return;
    emit({ ...state, snapshotLoading: loading });
  },
  setRosterTotal(total: number): void {
    if (state.rosterTotal === total) return;
    emit({ ...state, rosterTotal: total });
  },
  setOlderLoading(loading: boolean): void {
    if (state.olderLoading === loading) return;
    emit({ ...state, olderLoading: loading });
  },
  appendOlderEntries(entries: StoreSidePanelOlderEntry[], total: number): void {
    const shown = new Set([
      ...(state.snapshot?.items ?? []).map(featureKeyOf),
      ...state.olderEntries.map(featureKeyOf),
    ]);
    const fresh = entries.filter((entry) => !shown.has(featureKeyOf(entry)));
    emit({
      ...state,
      olderEntries: [...state.olderEntries, ...fresh],
      rosterTotal: total,
      olderLoading: false,
    });
  },
  toggleFeature(key: string): void {
    emit({
      ...state,
      selectedFeatureKeys: toggle(state.selectedFeatureKeys, key),
    });
  },
  clearSelections(): void {
    if (state.selectedFeatureKeys.size === 0) {
      return;
    }
    emit({
      ...state,
      selectedFeatureKeys: new Set(),
    });
  },
  reset(): void {
    emit(EMPTY);
  },
};

export const useStoreSidePanelState = (): StoreSidePanelState =>
  useSyncExternalStore(
    storeSidePanelStore.subscribe,
    storeSidePanelStore.getSnapshot,
    storeSidePanelStore.getSnapshot,
  );

export const refreshFeatureSnapshot = async (): Promise<void> => {
  const api = window.electronAPI?.store;
  if (!api?.readFeatureSnapshot) {
    storeSidePanelStore.setSnapshotLoading(false);
    return;
  }
  storeSidePanelStore.setSnapshotLoading(true);
  try {
    const snapshot = await api.readFeatureSnapshot();
    storeSidePanelStore.setSnapshot(snapshot);
  } catch {
    storeSidePanelStore.setSnapshotLoading(false);
  }
  // Probe the roster size so the list knows whether older features exist
  // beyond the snapshot window. Best-effort: without it the "Show older"
  // affordance simply stays hidden.
  if (!api.listFeatureRoster) return;
  try {
    const page = await api.listFeatureRoster({ limit: 1 });
    storeSidePanelStore.setRosterTotal(page.total);
  } catch {
    // Ignore — pagination is unavailable, the snapshot still renders.
  }
};

export const loadOlderFeatureEntries = async (): Promise<void> => {
  const api = window.electronAPI?.store;
  if (!api?.listFeatureRoster) return;
  const current = storeSidePanelStore.getSnapshot();
  if (current.olderLoading) return;
  const offset =
    (current.snapshot?.items.length ?? 0) + current.olderEntries.length;
  storeSidePanelStore.setOlderLoading(true);
  try {
    const page = await api.listFeatureRoster({
      limit: OLDER_PAGE_SIZE,
      offset,
    });
    storeSidePanelStore.appendOlderEntries(page.entries, page.total);
  } catch {
    storeSidePanelStore.setOlderLoading(false);
  }
};
