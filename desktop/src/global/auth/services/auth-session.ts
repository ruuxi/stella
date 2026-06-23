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
// Monotonic guard so a slow optimistic-then-revalidate sequence can never
// clobber the result of a newer refresh (e.g. a sign-in fired mid-revalidation).
let refreshVersion = 0;

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

type RefreshOptions = {
  // When true, accept the host's optimistically-hydrated (cached) session on the
  // first read so `isAuthenticated` can flip before the network settles, then
  // re-read for the authoritative (revalidated) session. Used by the cold-start
  // mount path. Sign-in / magic-link / deep-link callers leave this false so
  // they always observe the authoritative network result directly.
  allowCached?: boolean;
};

export const refreshAuthSession = async (options: RefreshOptions = {}) => {
  const allowCached = options.allowCached ?? false;
  // Coalesce concurrent optimistic refreshes, but never let an authoritative
  // refresh (e.g. post-sign-in) be swallowed by an in-flight optimistic one.
  if (inFlightRefresh && allowCached) {
    await inFlightRefresh;
    return;
  }
  if (inFlightRefresh) {
    await inFlightRefresh.catch(() => {});
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
  const version = ++refreshVersion;
  currentSession = { ...currentSession, isPending: true, error: null };
  emit();
  inFlightRefresh = configurePiRuntime()
    .then(async () => {
      // First read. With optimistic hydration the host may return a persisted
      // session immediately (no network) while it revalidates in the background.
      const first = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      if (allowCached && first) {
        // Surface the cached session right away (isPending:false) so Convex sees
        // isAuthenticated && !isLoading and starts fetching the access token /
        // running authenticated queries before get-session revalidation settles.
        currentSession = { data: first, isPending: false, error: null };
        emit();
      }
      // Authoritative follow-up read. The host returns the revalidated session
      // here (joining its in-flight revalidation, or the recorded result),
      // downgrading to null if it rejected the revalidation (401/403/404). This
      // also protects authoritative callers (sign-in / link) from ever emitting
      // a stale optimistic value: they skip the early emit above and only commit
      // this revalidated result.
      const revalidated = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      currentSession = { data: revalidated, isPending: false, error: null };
    })
    .catch((error) => {
      if (version !== refreshVersion) {
        return;
      }
      currentSession = {
        data: null,
        isPending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    })
    .finally(() => {
      inFlightRefresh = null;
      if (version === refreshVersion) {
        emit();
      }
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
  // Invalidate any in-flight optimistic refresh so a late revalidated emit
  // can't resurrect the signed-out session.
  refreshVersion += 1;
  currentSession = { data: null, isPending: false, error: null };
  emit();
};

export const deleteAuthUser = async () => {
  await window.electronAPI?.system.deleteAuthUser?.();
  refreshVersion += 1;
  currentSession = { data: null, isPending: false, error: null };
  emit();
};

export function getAuthSessionSnapshot(): AuthSessionResult {
  return currentSession;
}

export function useDesktopAuthSession() {
  const [snapshot, setSnapshot] = useState(currentSession);

  useEffect(() => {
    const listener = () => setSnapshot(currentSession);
    listeners.add(listener);
    if (currentSession.isPending && !inFlightRefresh) {
      void refreshAuthSession({ allowCached: true });
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return snapshot;
}
