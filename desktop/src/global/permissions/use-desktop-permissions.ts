import { useCallback, useEffect, useRef, useState } from "react";

export type DesktopPermissionKind = "accessibility" | "screen" | "microphone";

export type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export type DesktopPermissionStatus = Record<DesktopPermissionKind, boolean> & {
  microphoneStatus: MicrophonePermissionStatus;
};

type UseDesktopPermissionsOptions = {
  enabled?: boolean;
  pollMs: number;
  initialStatus: DesktopPermissionStatus;
  restartKinds?: readonly DesktopPermissionKind[];
  normalizeStatus?: (
    status: DesktopPermissionStatus,
  ) => DesktopPermissionStatus;
  unavailableMessage?: string;
  errorMessage?: (error: unknown) => string;
};

const defaultErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const useDesktopPermissions = ({
  enabled = true,
  pollMs,
  initialStatus,
  restartKinds = [],
  normalizeStatus,
  unavailableMessage = "Desktop permission status is unavailable in this window.",
  errorMessage = defaultErrorMessage,
}: UseDesktopPermissionsOptions) => {
  const [status, setStatus] = useState(initialStatus);
  const [loaded, setLoaded] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<DesktopPermissionKind | null>(
    null,
  );
  const [restartRecommended, setRestartRecommended] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const lastStatusRef = useRef<DesktopPermissionStatus | null>(null);

  const refresh = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.getPermissionStatus) {
      throw new Error(unavailableMessage);
    }

    const rawStatus = await systemApi.getPermissionStatus();
    const nextStatus = normalizeStatus?.(rawStatus) ?? rawStatus;
    const previousStatus = lastStatusRef.current;
    if (
      previousStatus &&
      restartKinds.some((kind) => !previousStatus[kind] && nextStatus[kind])
    ) {
      setRestartRecommended(true);
    }
    lastStatusRef.current = nextStatus;
    setStatus(nextStatus);
    return nextStatus;
  }, [normalizeStatus, restartKinds, unavailableMessage]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const load = async () => {
      try {
        const nextStatus = await refresh();
        if (!cancelled) {
          setError(null);
          setStatus(nextStatus);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(errorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, errorMessage, pollMs, refresh]);

  const requestWithSettingsFallback = useCallback(
    async (kind: DesktopPermissionKind) => {
      const systemApi = window.electronAPI?.system;
      if (
        !systemApi?.requestPermission ||
        !systemApi.openPermissionSettings ||
        !systemApi.getPermissionStatus
      ) {
        throw new Error("Desktop permissions are unavailable in this window.");
      }

      setActiveAction(kind);
      try {
        const result = await systemApi.requestPermission(kind);
        const nextStatus = await refresh();
        if (!nextStatus[kind] && !result.granted && !result.openedSettings) {
          await systemApi.openPermissionSettings(kind);
        }
        return nextStatus;
      } finally {
        setActiveAction(null);
      }
    },
    [refresh],
  );

  const restart = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.quitForRestart) {
      throw new Error("Restart is unavailable in this window.");
    }

    setIsRestarting(true);
    try {
      const result = await systemApi.quitForRestart();
      if (!result?.ok) {
        setIsRestarting(false);
      }
      return result;
    } catch (restartError) {
      setIsRestarting(false);
      throw restartError;
    }
  }, []);

  return {
    status,
    setStatus,
    loaded,
    error,
    setError,
    activeAction,
    setActiveAction,
    restartRecommended,
    setRestartRecommended,
    isRestarting,
    refresh,
    requestWithSettingsFallback,
    restart,
  };
};
