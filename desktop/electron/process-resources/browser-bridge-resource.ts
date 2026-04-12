import { ProcessRuntime } from "../process-runtime.js";
import { StellaBrowserBridgeService } from "../services/stella-browser-bridge-service.js";
import { createManagedResource } from "../managed-resource.js";

const TOAST_AFTER_RETRY_ATTEMPTS = 3;

type StellaBrowserBridgeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "host_registration_failed";

export type StellaBrowserBridgeStatus = {
  state: StellaBrowserBridgeState;
  attempt: number;
  nextRetryMs?: number;
  error?: string;
  notifyUser?: boolean;
};

export type StellaBrowserBridgeResource = {
  start: () => void;
  stop: () => Promise<void>;
};

export const createStellaBrowserBridgeResource = (options: {
  stellaRoot: string;
  processRuntime: ProcessRuntime;
  onStatus: (status: StellaBrowserBridgeStatus) => void;
}): StellaBrowserBridgeResource => {
  let toastShownForCurrentOutage = false;

  return createManagedResource<StellaBrowserBridgeService>({
    processRuntime: options.processRuntime,
    create: ({ onUnexpectedExit }) =>
      new StellaBrowserBridgeService({
        stellaRoot: options.stellaRoot,
        onUnexpectedExit,
      }),
    start: (s) => s.start(),
    stop: (s) => s.stop(),
    onAttempt: ({ attempt }) => {
      options.onStatus({
        state: attempt === 0 ? "connecting" : "reconnecting",
        attempt,
      });
    },
    onStarted: () => {
      toastShownForCurrentOutage = false;
      options.onStatus({ state: "connected", attempt: 0 });
    },
    onRetry: ({ attempt, delayMs, error }) => {
      const notifyUser =
        !toastShownForCurrentOutage && attempt > TOAST_AFTER_RETRY_ATTEMPTS;
      if (notifyUser) toastShownForCurrentOutage = true;
      options.onStatus({
        state: "reconnecting",
        attempt,
        nextRetryMs: delayMs,
        error,
        notifyUser,
      });
    },
    onError: (error) => {
      const isHostRegistration =
        error.includes("browser extension connector") ||
        error.includes("Native messaging host registration") ||
        error.includes("Browser bridge is not installed");
      if (!isHostRegistration) {
        return;
      }
      options.onStatus({
        state: "host_registration_failed",
        attempt: 0,
        error,
        notifyUser: true,
      });
    },
  });
};
