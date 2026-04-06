import { useSyncExternalStore } from "react";
import type { OfficePreviewSnapshot } from "@/shared/contracts/office-preview";

type OfficePreviewStoreState = {
  byId: Record<string, OfficePreviewSnapshot>;
  initialized: boolean;
};

let state: OfficePreviewStoreState = {
  byId: {},
  initialized: false,
};

const listeners = new Set<() => void>();
let initializePromise: Promise<void> | null = null;
let unsubscribeUpdates: (() => void) | null = null;

const emitChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const mergeSnapshot = (snapshot: OfficePreviewSnapshot) => {
  const current = state.byId[snapshot.sessionId];
  if (current && current.updatedAt >= snapshot.updatedAt) {
    return;
  }

  state = {
    ...state,
    byId: {
      ...state.byId,
      [snapshot.sessionId]: snapshot,
    },
  };
  emitChange();
};

const initializeOfficePreviewStore = async () => {
  if (state.initialized) {
    return;
  }
  if (initializePromise) {
    await initializePromise;
    return;
  }

  initializePromise = (async () => {
    const api = window.electronAPI?.officePreview;
    if (!api) {
      state = { ...state, initialized: true };
      emitChange();
      return;
    }

    const initialSnapshots = await api.list();
    const nextById: Record<string, OfficePreviewSnapshot> = {};
    for (const snapshot of initialSnapshots) {
      nextById[snapshot.sessionId] = snapshot;
    }

    state = {
      byId: nextById,
      initialized: true,
    };
    emitChange();

    unsubscribeUpdates?.();
    unsubscribeUpdates = api.onUpdate((snapshot) => {
      mergeSnapshot(snapshot);
    });
  })().finally(() => {
    initializePromise = null;
  });

  await initializePromise;
};

const subscribeOfficePreviewStore = (listener: () => void) => {
  listeners.add(listener);
  void initializeOfficePreviewStore();

  return () => {
    listeners.delete(listener);
  };
};

const getOfficePreviewStoreSnapshot = () => state;

export const useOfficePreview = (sessionId?: string | null) => {
  const snapshot = useSyncExternalStore(
    subscribeOfficePreviewStore,
    getOfficePreviewStoreSnapshot,
    getOfficePreviewStoreSnapshot,
  );

  return sessionId ? snapshot.byId[sessionId] : undefined;
};
