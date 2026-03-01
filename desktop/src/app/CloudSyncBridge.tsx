import { useEffect } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/api";

/**
 * Tells the Electron main process whether cloud sync should be active.
 * Cloud sync is disabled for anonymous users (nothing to upload) and
 * for logged-in users in private/local mode.
 */
export const CloudSyncBridge = () => {
  const { isAuthenticated } = useConvexAuth();

  const user = useQuery(
    api.auth.getCurrentUser,
    isAuthenticated ? {} : "skip",
  ) as { isAnonymous?: boolean } | null | undefined;

  const accountMode = useQuery(
    api.data.preferences.getAccountMode,
    isAuthenticated ? {} : "skip",
  ) as "private_local" | "connected" | undefined;

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setCloudSyncEnabled) return;

    // Wait until both queries have resolved before deciding.
    if (!isAuthenticated || user === undefined || accountMode === undefined) {
      void electronApi.setCloudSyncEnabled({ enabled: false });
      return;
    }

    const enabled = user !== null && !user.isAnonymous && accountMode === "connected";
    void electronApi.setCloudSyncEnabled({ enabled });
  }, [isAuthenticated, user, accountMode]);

  // Disable on unmount
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.setCloudSyncEnabled) return undefined;
    return () => {
      void electronApi.setCloudSyncEnabled({ enabled: false });
    };
  }, []);

  return null;
};
