import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { getConvexToken } from "@/services/auth-token";

export const AuthTokenBridge = () => {
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setAuthState) {
      return undefined;
    }

    if (!isAuthenticated) {
      void electronApi.setAuthState({ authenticated: false });
      return undefined;
    }

    // Fetch the Convex JWT and send it to the main process so the runner
    // can authenticate directly (BetterAuth crossDomain stores sessions in
    // localStorage, not cookies, so the main process cannot fetch its own token).
    void getConvexToken().then((token) => {
      void electronApi.setAuthState({ authenticated: true, token: token ?? undefined });
    });

    // Refresh the token every 3 minutes (JWT lifetime is 5 min)
    const interval = setInterval(() => {
      void getConvexToken().then((token) => {
        if (token) {
          void electronApi.setAuthState({ authenticated: true, token });
        }
      });
    }, 3 * 60 * 1000);

    return () => clearInterval(interval);
  }, [isAuthenticated]);

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
