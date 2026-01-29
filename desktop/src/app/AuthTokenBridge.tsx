import { useEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { getAuthToken } from "@/services/auth-token";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export const AuthTokenBridge = () => {
  const { isAuthenticated } = useConvexAuth();
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;

    const syncToken = async () => {
      if (!api?.setAuthToken) {
        return;
      }
      if (!isAuthenticated) {
        await api.setAuthToken({ token: null });
        return;
      }
      try {
        const token = await getAuthToken();
        if (!cancelled) {
          await api.setAuthToken({ token });
        }
      } catch {
        if (!cancelled) {
          await api.setAuthToken({ token: null });
        }
      }
    };

    void syncToken();

    if (api?.setAuthToken && isAuthenticated) {
      refreshTimer.current = window.setInterval(syncToken, REFRESH_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (refreshTimer.current) {
        window.clearInterval(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [isAuthenticated]);

  return null;
};
