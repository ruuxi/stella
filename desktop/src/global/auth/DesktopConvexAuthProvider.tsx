import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ConvexProviderWithAuth } from "convex/react";
import { authClient } from "@/global/auth/lib/auth-client";
import { getConvexToken, clearCachedToken } from "@/global/auth/services/auth-token";
import { convexClient } from "@/infra/convex-client";

const TOKEN_BOOTSTRAP_RETRY_MS = 3_000;
const TOKEN_REFRESH_FALLBACK_MS = 3 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 45_000;
const TOKEN_MIN_REFRESH_MS = 15_000;

export const getHostTokenRefreshDelayMs = (token: string): number => {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    if (typeof payload.exp !== "number") {
      throw new Error("Missing exp claim");
    }
    return Math.max(
      TOKEN_MIN_REFRESH_MS,
      payload.exp * 1000 - Date.now() - TOKEN_REFRESH_MARGIN_MS,
    );
  } catch {
    return TOKEN_REFRESH_FALLBACK_MS;
  }
};

function useDesktopConvexAuth() {
  const session = authClient.useSession();

  const sessionUserId =
    (session.data as { user?: { id?: string } } | null | undefined)?.user?.id ??
    null;

  useEffect(() => {
    clearCachedToken();
  }, [sessionUserId]);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
      return await getConvexToken({ forceRefresh: forceRefreshToken });
    },
    // Intentionally keyed on sessionUserId so ConvexProviderWithAuth re-calls
    // setAuth when the signed-in identity changes (e.g. anonymous → real account).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionUserId],
  );

  return useMemo(
    () => ({
      isLoading: Boolean(session.isPending),
      isAuthenticated: Boolean(session.data),
      fetchAccessToken,
    }),
    [fetchAccessToken, session.data, session.isPending],
  );
}

function DesktopAuthRuntimeEffects() {
  const session = authClient.useSession();
  const attemptedAnonAuthRef = useRef(false);
  const sessionUser = (
    session.data as { user?: { isAnonymous?: boolean | null } } | null | undefined
  )?.user;
  const hasSession = Boolean(session.data);
  const hasConnectedAccount = hasSession && sessionUser?.isAnonymous !== true;
  const isSessionPending = Boolean(session.isPending);

  useEffect(() => {
    if (session.isPending) return;

    if (session.data) {
      attemptedAnonAuthRef.current = false;
      return;
    }

    if (attemptedAnonAuthRef.current) return;
    attemptedAnonAuthRef.current = true;

    void authClient.signIn.anonymous().catch(() => {
      attemptedAnonAuthRef.current = false;
    });
  }, [session.data, session.isPending]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) {
      return;
    }

    // Cloud sync stays intentionally disabled; auth sessions are local-only for now.
    void systemApi.setCloudSyncEnabled({ enabled: false });

    return () => {
      void systemApi.setCloudSyncEnabled({ enabled: false });
    };
  }, []);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      return;
    }

    if (isSessionPending) {
      return;
    }

    if (!hasSession) {
      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleRefresh = (token: string) => {
      if (cancelled) {
        return;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void syncToken({ forceRefreshToken: true });
      }, getHostTokenRefreshDelayMs(token));
    };

    const syncToken = async (
      { forceRefreshToken = false }: { forceRefreshToken?: boolean } = {},
    ) => {
      const token = (await getConvexToken({
        forceRefresh: forceRefreshToken,
      })) ?? undefined;
      if (cancelled) return;

      if (token) {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        void systemApi.setAuthState({
          authenticated: true,
          token,
          hasConnectedAccount,
        });
        scheduleRefresh(token);
        return;
      }

      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void syncToken();
        }, TOKEN_BOOTSTRAP_RETRY_MS);
      }
    };

    void syncToken();

    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [hasConnectedAccount, hasSession, isSessionPending]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      return;
    }

    return () => {
      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
    };
  }, []);

  return null;
}

export function DesktopConvexAuthProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convexClient} useAuth={useDesktopConvexAuth}>
      <DesktopAuthRuntimeEffects />
      {children}
    </ConvexProviderWithAuth>
  );
}
