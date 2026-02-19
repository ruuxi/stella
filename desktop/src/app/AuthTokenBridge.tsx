import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@/convex/api";

export const AuthTokenBridge = () => {
  const { isAuthenticated } = useConvexAuth();
  const ensureCloudPrimary = useMutation(api.data.preferences.ensureCloudPrimary);

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setAuthState) {
      return undefined;
    }
    void electronApi.setAuthState({ authenticated: isAuthenticated });
    return undefined;
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void ensureCloudPrimary({}).catch((error) => {
      console.error("[AuthTokenBridge] Failed to enable cloud primary:", error);
    });
  }, [isAuthenticated, ensureCloudPrimary]);

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
