import { dismissToast, showToast, type ToastOptions } from "@/ui/toast";
import { setLocalDictationPreference } from "@/features/dictation/services/inworld-dictation";

let activeDownload: Promise<void> | null = null;

export const startLocalDictationDownload = (): Promise<void> => {
  if (activeDownload) return activeDownload;

  const loadingToastId = showToast({
    title: "Downloading voice feature",
    description:
      "The download is continuing in the background. You can keep using Stella.",
    variant: "loading",
    duration: 0,
  });

  activeDownload = (async () => {
    const download = window.electronAPI?.dictation?.downloadLocalModel;
    if (!download) {
      throw new Error("Local dictation downloads are unavailable.");
    }
    setLocalDictationPreference(true);
    const result = await download();
    if (!result.available) {
      throw new Error(result.reason ?? "Local dictation is unavailable.");
    }
    dismissToast(loadingToastId);
    showToast({
      title: "Voice feature is ready",
      description: "On-device dictation is ready to use.",
      variant: "success",
      duration: 6000,
    });
  })()
    .catch((error) => {
      dismissToast(loadingToastId);
      console.warn("[dictation] voice feature download failed:", error);
      showToast({
        title: "Voice feature couldn't be downloaded",
        description: "Check your connection and try downloading it again.",
        variant: "error",
        duration: 8000,
        action: DOWNLOAD_LOCAL_DICTATION_ACTION,
      });
    })
    .finally(() => {
      activeDownload = null;
    });

  return activeDownload;
};

export const DOWNLOAD_LOCAL_DICTATION_ACTION: NonNullable<
  ToastOptions["action"]
> = {
  label: "Download voice feature",
  onClick: () => {
    void startLocalDictationDownload();
  },
};
