import { useEffect } from "react";
import { useConvexAuth } from "convex/react";

export const AuthTokenBridge = () => {
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setAuthState) {
      return undefined;
    }
    void electronApi.setAuthState({ authenticated: isAuthenticated });
    return undefined;
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
