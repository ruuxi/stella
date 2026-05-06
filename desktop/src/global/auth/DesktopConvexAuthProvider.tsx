import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConvexProviderWithAuth } from "convex/react";
import { MagicLinkAuthProvider } from "@/global/auth/useMagicLinkAuth";
import { getConvexToken, clearCachedToken } from "@/global/auth/services/auth-token";
import {
  signInAnonymous,
  useDesktopAuthSession,
} from "@/global/auth/services/auth-session";
import { convexClient } from "@/infra/convex-client";

const TOKEN_BOOTSTRAP_RETRY_MS = 3_000;
const TOKEN_REFRESH_FALLBACK_MS = 3 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 90_000;
const TOKEN_MIN_REFRESH_MS = 15_000;

export type AuthBootstrapStatus =
  | "loading_session"
  | "creating_anonymous_session"
  | "syncing_runtime_token"
  | "ready"
  | "failed";

type AuthBootstrapState = {
  status: AuthBootstrapStatus;
  error: string | null;
};

type AuthBootstrapContextValue = AuthBootstrapState & {
  runtimeAuthReady: boolean;
};

const AuthBootstrapContext = createContext<AuthBootstrapContextValue>({
  status: "loading_session",
  error: null,
  runtimeAuthReady: false,
});

export function useAuthBootstrapState() {
  return useContext(AuthBootstrapContext);
}

const getHostTokenRefreshDelayMs = (token: string): number => {
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
  const session = useDesktopAuthSession();

  const sessionUserId =
    (session.data as { user?: { id?: string } } | null | undefined)?.user?.id ??
    null;
  const sessionIsAnonymous =
    (session.data as { user?: { isAnonymous?: boolean | null } } | null | undefined)
      ?.user?.isAnonymous === true;

  useEffect(() => {
    clearCachedToken();
  }, [sessionIsAnonymous, sessionUserId]);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
      return await getConvexToken({ forceRefresh: forceRefreshToken });
    },
    // Intentionally keyed on sessionUserId and sessionIsAnonymous so
    // ConvexProviderWithAuth re-calls setAuth when the signed-in identity
    // changes, including anonymous → real account links that preserve user.id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionIsAnonymous, sessionUserId],
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

function DesktopAuthRuntimeEffects({
  setAuthBootstrapState,
}: {
  setAuthBootstrapState: (state: AuthBootstrapState) => void;
}) {
  const session = useDesktopAuthSession();
  const attemptedAnonAuthRef = useRef(false);
  const runtimeAuthRefreshHandlerRef = useRef<((args?: {
    forceRefreshToken?: boolean;
    requestId?: string;
  }) => Promise<void>) | null>(null);
  const sessionUser = (
    session.data as { user?: { isAnonymous?: boolean | null } } | null | undefined
  )?.user;
  const hasSession = Boolean(session.data);
  const hasConnectedAccount = hasSession && sessionUser?.isAnonymous !== true;
  const isSessionPending = Boolean(session.isPending);

  useEffect(() => {
    if (session.isPending) {
      setAuthBootstrapState({ status: "loading_session", error: null });
      return;
    }

    if (session.data) {
      attemptedAnonAuthRef.current = false;
      return;
    }

    if (attemptedAnonAuthRef.current) return;
    attemptedAnonAuthRef.current = true;
    setAuthBootstrapState({
      status: "creating_anonymous_session",
      error: null,
    });

    void signInAnonymous().catch(() => {
      attemptedAnonAuthRef.current = false;
      setAuthBootstrapState({
        status: "failed",
        error: "Stella could not create a local sign-in session.",
      });
    });
  }, [session.data, session.isPending, setAuthBootstrapState]);

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
    if (
      !systemApi?.onRuntimeAuthRefreshRequested
      || !systemApi.completeRuntimeAuthRefresh
    ) {
      return;
    }

    return systemApi.onRuntimeAuthRefreshRequested(({ requestId }) => {
      const syncToken = runtimeAuthRefreshHandlerRef.current;
      if (syncToken) {
        void syncToken({ forceRefreshToken: true, requestId });
        return;
      }
      void systemApi.completeRuntimeAuthRefresh({
        requestId,
        authenticated: false,
        hasConnectedAccount: false,
      });
    });
  }, []);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      runtimeAuthRefreshHandlerRef.current = null;
      setAuthBootstrapState({
        status: "failed",
        error: "Stella could not connect auth to the desktop runtime.",
      });
      return;
    }

    if (isSessionPending) {
      runtimeAuthRefreshHandlerRef.current = null;
      setAuthBootstrapState({ status: "loading_session", error: null });
      return;
    }

    if (!hasSession) {
      runtimeAuthRefreshHandlerRef.current = null;
      setAuthBootstrapState({
        status: "creating_anonymous_session",
        error: null,
      });
      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
      return;
    }

    setAuthBootstrapState({
      status: "syncing_runtime_token",
      error: null,
    });

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
      {
        forceRefreshToken = false,
        requestId,
      }: { forceRefreshToken?: boolean; requestId?: string } = {},
    ) => {
      let token: string | undefined;
      try {
        token =
          (await getConvexToken({
            forceRefresh: forceRefreshToken,
          })) ?? undefined;
      } catch {
        token = undefined;
      }
      if (cancelled) return;

      if (token) {
        const nextState = {
          authenticated: true,
          token,
          hasConnectedAccount,
        } as const;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        void systemApi.setAuthState(nextState);
        if (requestId && systemApi.completeRuntimeAuthRefresh) {
          void systemApi.completeRuntimeAuthRefresh({
            requestId,
            ...nextState,
          });
        }
        scheduleRefresh(token);
        setAuthBootstrapState({ status: "ready", error: null });
        return;
      }

      const nextState = {
        authenticated: false,
        hasConnectedAccount: false,
      } as const;
      void systemApi.setAuthState(nextState);
      if (requestId && systemApi.completeRuntimeAuthRefresh) {
        void systemApi.completeRuntimeAuthRefresh({
          requestId,
          ...nextState,
        });
      }
      if (!retryTimer) {
        setAuthBootstrapState({
          status: "syncing_runtime_token",
          error: null,
        });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void syncToken();
        }, TOKEN_BOOTSTRAP_RETRY_MS);
      }
    };

    runtimeAuthRefreshHandlerRef.current = syncToken;
    void syncToken();

    return () => {
      cancelled = true;
      runtimeAuthRefreshHandlerRef.current = null;
      clearTimers();
    };
  }, [hasConnectedAccount, hasSession, isSessionPending, setAuthBootstrapState]);

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
  const [authBootstrapState, setAuthBootstrapState] =
    useState<AuthBootstrapState>({
      status: "loading_session",
      error: null,
    });
  const authBootstrapValue = useMemo(
    () => ({
      ...authBootstrapState,
      runtimeAuthReady: authBootstrapState.status === "ready",
    }),
    [authBootstrapState],
  );

  return (
    <ConvexProviderWithAuth client={convexClient} useAuth={useDesktopConvexAuth}>
      <AuthBootstrapContext.Provider value={authBootstrapValue}>
        <MagicLinkAuthProvider>
          <DesktopAuthRuntimeEffects
            setAuthBootstrapState={setAuthBootstrapState}
          />
          {children}
        </MagicLinkAuthProvider>
      </AuthBootstrapContext.Provider>
    </ConvexProviderWithAuth>
  );
}
