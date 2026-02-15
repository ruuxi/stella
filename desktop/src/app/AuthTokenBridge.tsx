import { useEffect } from "react";
import { useConvexAuth } from "convex/react";

export const AuthTokenBridge = () => {
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.setAuthState) {
      return undefined;
    }
    void api.setAuthState({ authenticated: isAuthenticated });
    return undefined;
  }, [isAuthenticated]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.setAuthState) {
      return undefined;
    }

    return () => {
      // Ensure the host clears auth when this bridge unmounts.
      void api.setAuthState({ authenticated: false });
    };
  }, []);

  return null;
};
