import { useEffect } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { getConvexToken } from "@/services/auth-token";
import { api } from "@/convex/api";

const PROXY_TOKEN_REFRESH_MS = 3 * 60 * 1000;

const buildProxyRunId = () => {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return `desktop:proxy:${suffix}`;
};

export const AuthTokenBridge = () => {
  const { isAuthenticated } = useConvexAuth();
  const mintProxyToken = useAction(api["agent/mint_proxy_token"].mintProxyToken);

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setAuthState) {
      return undefined;
    }

    if (!isAuthenticated) {
      void electronApi.setAuthState({ authenticated: false });
      return undefined;
    }

    let cancelled = false;
    const syncToken = async () => {
      try {
        const minted = await mintProxyToken({
          agentType: "orchestrator",
          runId: buildProxyRunId(),
          platform: window.electronAPI?.platform,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (cancelled) return;
        void electronApi.setAuthState({
          authenticated: true,
          token: minted?.proxyToken?.token ?? undefined,
        });
        return;
      } catch {
        // Fall back to Convex JWT mode when proxy-token minting is unavailable.
      }

      const token = await getConvexToken();
      if (cancelled) return;
      void electronApi.setAuthState({ authenticated: true, token: token ?? undefined });
    };

    void syncToken();
    const interval = setInterval(() => {
      void syncToken();
    }, PROXY_TOKEN_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isAuthenticated, mintProxyToken]);

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setAuthState) {
      return undefined;
    }

    return () => {
      // Ensure the host clears auth when this bridge unmounts.
      void electronApi.setAuthState({ authenticated: false });
    };
  }, []);

  return null;
};
