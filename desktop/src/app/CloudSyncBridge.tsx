import { useEffect } from "react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useAccountMode } from "@/hooks/use-account-mode";

/**
 * Tells the Electron main process whether cloud sync should be active.
 * Cloud sync is disabled for anonymous users (nothing to upload) and
 * for logged-in users in private/local mode.
 */
export const CloudSyncBridge = () => {
  const { user, isAuthenticated } = useCurrentUser();
  const accountMode = useAccountMode();

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
