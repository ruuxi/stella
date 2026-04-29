/**
 * Side panel state: feature roster + selected feature ids.
 *
 * The Store side panel renders one row per feature group (collapsed
 * Stella self-mod commits) and lets the user multi-select. Selections
 * stay client-only; the publish action reads them at click time and
 * forwards to the backend Store agent.
 *
 * Side panel state machine (Idle/Working/Pick/Draft/Done) derives
 * from the Convex thread, NOT this store. That keeps refresh /
 * reopen behavior honest without duplicating state.
 */
import { useSyncExternalStore } from "react";
import type {
  StorePackageRecord,
  StoreThreadFeatureRoster,
  InstalledStoreModRecord,
} from "@/shared/types/electron";

export type StoreSidePanelState = {
  roster: StoreThreadFeatureRoster | null;
  rosterLoading: boolean;
  packages: StorePackageRecord[];
  installedMods: InstalledStoreModRecord[];
  /** Selected feature ids from the linear list. */
  selectedFeatureIds: Set<string>;
  /**
   * Selected installed-add-on package ids (for the "this row has an
   * available update; selecting it triggers update" flow). Mutually
   * fine with feature selections; the action button decides whether
   * they form a publish or update batch.
   */
  selectedInstalledPackageIds: Set<string>;
};

const EMPTY: StoreSidePanelState = {
  roster: null,
  rosterLoading: true,
  packages: [],
  installedMods: [],
  selectedFeatureIds: new Set(),
  selectedInstalledPackageIds: new Set(),
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
  setRoster(roster: StoreThreadFeatureRoster): void {
    emit({ ...state, roster, rosterLoading: false });
  },
  setRosterLoading(loading: boolean): void {
    if (state.rosterLoading === loading) return;
    emit({ ...state, rosterLoading: loading });
  },
  setPackages(packages: StorePackageRecord[]): void {
    emit({ ...state, packages });
  },
  setInstalledMods(installedMods: InstalledStoreModRecord[]): void {
    emit({ ...state, installedMods });
  },
  toggleFeature(featureId: string): void {
    emit({
      ...state,
      selectedFeatureIds: toggle(state.selectedFeatureIds, featureId),
    });
  },
  toggleInstalled(packageId: string): void {
    emit({
      ...state,
      selectedInstalledPackageIds: toggle(
        state.selectedInstalledPackageIds,
        packageId,
      ),
    });
  },
  clearSelections(): void {
    if (
      state.selectedFeatureIds.size === 0
      && state.selectedInstalledPackageIds.size === 0
    ) {
      return;
    }
    emit({
      ...state,
      selectedFeatureIds: new Set(),
      selectedInstalledPackageIds: new Set(),
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

export const refreshFeatureRoster = async (): Promise<void> => {
  const api = window.electronAPI?.store;
  if (!api?.listFeatureRoster) {
    storeSidePanelStore.setRosterLoading(false);
    return;
  }
  storeSidePanelStore.setRosterLoading(true);
  try {
    const roster = await api.listFeatureRoster();
    storeSidePanelStore.setRoster(roster);
  } catch {
    storeSidePanelStore.setRosterLoading(false);
  }
};
