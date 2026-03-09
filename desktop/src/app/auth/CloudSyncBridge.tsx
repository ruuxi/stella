import { useEffect } from "react";

/**
 * Tells the Electron main process whether cloud sync should be active.
 * Cloud sync is disabled for anonymous users (nothing to upload) and
 * for logged-in users in private/local mode.
 */
export const CloudSyncBridge = () => {
  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) return;
    void systemApi.setCloudSyncEnabled({ enabled: false });
  }, []);

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
