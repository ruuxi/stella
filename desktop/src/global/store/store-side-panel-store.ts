/**
 * Side-panel selection state.
 *
 * Phase 1 ships only the rolling-window feature snapshot the namer LLM
 * regenerates after every self-mod commit. Multi-select state lives
 * here so the user's picks survive remounts; everything else (chat
 * thread, draft state, publish flow) is rebuilt in Phase 2 around the
 * new blueprint flow.
 */
import { useSyncExternalStore } from "react";
import type { SelfModFeatureSnapshot } from "@/shared/types/electron";

type StoreSidePanelState = {
  snapshot: SelfModFeatureSnapshot | null;
  snapshotLoading: boolean;
  /** Selected feature names from the snapshot (display names — agent never sees commit hashes). */
  selectedFeatureNames: Set<string>;
};

const EMPTY: StoreSidePanelState = {
  snapshot: null,
  snapshotLoading: true,
  selectedFeatureNames: new Set(),
};

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
  toggleFeature(name: string): void {
    emit({
      ...state,
      selectedFeatureNames: toggle(state.selectedFeatureNames, name),
    });
  },
  clearSelections(): void {
    if (state.selectedFeatureNames.size === 0) {
      return;
    }
    emit({
      ...state,
      selectedFeatureNames: new Set(),
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
};
