import { useEffect } from "react";
import { getConvexToken } from "@/app/auth/services/auth-token";
import { authClient } from "@/app/auth/lib/auth-client";

const TOKEN_REFRESH_MS = 3 * 60 * 1000;
const TOKEN_BOOTSTRAP_RETRY_MS = 3_000;

export const AuthTokenBridge = () => {
  const session = authClient.useSession();
  const hasSession = Boolean(session.data);
  const isSessionPending = Boolean(session.isPending);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      return undefined;
    }

    // Avoid clearing host auth while BetterAuth session lookup is still in-flight.
    if (isSessionPending) {
      return undefined;
    }

    if (!hasSession) {
      void systemApi.setAuthState({ authenticated: false });
      return undefined;
    }

    let cancelled = false;
    let refreshInterval: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const syncToken = async () => {
      const token = (await getConvexToken()) ?? undefined;
      if (cancelled) return;

      if (token) {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        void systemApi.setAuthState({ authenticated: true, token });
        if (!refreshInterval) {
          refreshInterval = setInterval(() => {
            void syncToken();
          }, TOKEN_REFRESH_MS);
        }
        return;
      }

      // No token yet: keep host in unauthenticated state and retry quickly.
      void systemApi.setAuthState({ authenticated: false });
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
  }, [hasSession, isSessionPending]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      return undefined;
    }

    return () => {
      void systemApi.setAuthState({ authenticated: false });
    };
  }, []);

  return null;
};
