import { useEffect, useState } from "react";
import { configurePiRuntime } from "@/platform/electron/device";

type AuthSessionResult = {
  data: unknown | null;
  isPending: boolean;
  error: Error | null;
};

let currentSession: AuthSessionResult = {
  data: null,
  isPending: true,
  error: null,
};
const listeners = new Set<() => void>();
let inFlightRefresh: Promise<void> | null = null;

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const refreshAuthSession = async () => {
  if (inFlightRefresh) {
    await inFlightRefresh;
    return;
  }
  const systemApi = window.electronAPI?.system;
  if (!systemApi?.getAuthSession) {
    currentSession = {
      data: null,
      isPending: false,
      error: new Error("Desktop auth API is unavailable."),
    };
    emit();
    return;
  }
  currentSession = { ...currentSession, isPending: true, error: null };
  emit();
  inFlightRefresh = configurePiRuntime()
    .then(() => systemApi.getAuthSession())
    .then((data) => {
      currentSession = { data, isPending: false, error: null };
    })
    .catch((error) => {
      currentSession = {
        data: null,
        isPending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    })
    .finally(() => {
      inFlightRefresh = null;
      emit();
    });
  await inFlightRefresh;
};

export const signInAnonymous = async () => {
  await configurePiRuntime();
  await window.electronAPI?.system.signInAnonymous?.();
  await refreshAuthSession();
};

export const signOutAuthSession = async () => {
  await window.electronAPI?.system.signOutAuth?.();
  currentSession = { data: null, isPending: false, error: null };
  emit();
};

export const deleteAuthUser = async () => {
  await window.electronAPI?.system.deleteAuthUser?.();
  currentSession = { data: null, isPending: false, error: null };
  emit();
};

export function useDesktopAuthSession() {
  const [snapshot, setSnapshot] = useState(currentSession);

  useEffect(() => {
    const listener = () => setSnapshot(currentSession);
    listeners.add(listener);
    if (currentSession.isPending && !inFlightRefresh) {
      void refreshAuthSession();
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return snapshot;
}
