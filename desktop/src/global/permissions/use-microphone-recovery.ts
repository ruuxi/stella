import { useCallback, useState } from "react";

type UseMicrophoneRecoveryOptions = {
  onError?: (error: unknown) => void;
};

export const useMicrophoneRecovery = ({
  onError,
}: UseMicrophoneRecoveryOptions = {}) => {
  const [isResetting, setIsResetting] = useState(false);

  const openSettings = useCallback(() => {
    void window.electronAPI?.system.openPermissionSettings?.("microphone");
  }, []);

  const resetAndRestart = useCallback(async () => {
    setIsResetting(true);
    try {
      const resetResult =
        await window.electronAPI?.system.resetMicrophonePermission?.();
      if (!resetResult?.ok) {
        setIsResetting(false);
        return;
      }
      const quitResult = await window.electronAPI?.system.quitForRestart?.();
      if (!quitResult?.ok) {
        setIsResetting(false);
      }
    } catch (error) {
      setIsResetting(false);
      onError?.(error);
    }
  }, [onError]);

  return {
    isResetting,
    openSettings,
    resetAndRestart,
  };
};
