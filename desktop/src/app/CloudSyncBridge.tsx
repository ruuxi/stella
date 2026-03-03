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
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) return;

    // Wait until both queries have resolved before deciding.
    if (!isAuthenticated || user === undefined || accountMode === undefined) {
      void systemApi.setCloudSyncEnabled({ enabled: false });
      return;
    }

    const enabled = user !== null && !user.isAnonymous && accountMode === "connected";
    void systemApi.setCloudSyncEnabled({ enabled });
  }, [isAuthenticated, user, accountMode]);

  // Disable on unmount
  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) return undefined;
    return () => {
      void systemApi.setCloudSyncEnabled({ enabled: false });
    };
  }, []);

  return null;
};
