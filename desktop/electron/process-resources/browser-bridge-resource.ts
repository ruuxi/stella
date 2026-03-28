import { ProcessRuntime } from "../process-runtime.js";
import {
  StellaBrowserBridgeService,
} from "../services/stella-browser-bridge-service.js";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const TOAST_AFTER_RETRY_ATTEMPTS = 3;

type StellaBrowserBridgeState = "connecting" | "connected" | "reconnecting";

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
  frontendRoot: string;
  processRuntime: ProcessRuntime;
  onStatus: (status: StellaBrowserBridgeStatus) => void;
}): StellaBrowserBridgeResource => {
  let service: StellaBrowserBridgeService | null = null;
  let launchPromise: Promise<void> | null = null;
  let retryTimerCancel: (() => void) | null = null;
  let stopped = true;
  let retryAttempt = 0;
  let toastShownForCurrentOutage = false;

  const clearRetryTimer = () => {
    retryTimerCancel?.();
    retryTimerCancel = null;
  };

  const stopService = async () => {
    const activeService = service;
    service = null;
    await activeService?.stop();
  };

  const scheduleReconnect = (error: string) => {
    if (stopped || options.processRuntime.isShuttingDown()) {
      return;
    }

    retryAttempt += 1;
    const nextRetryMs = Math.min(
      RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryAttempt - 1),
      RETRY_MAX_DELAY_MS,
    );
    const notifyUser =
      !toastShownForCurrentOutage &&
      retryAttempt > TOAST_AFTER_RETRY_ATTEMPTS;

    if (notifyUser) {
      toastShownForCurrentOutage = true;
    }

    options.onStatus({
      state: "reconnecting",
      attempt: retryAttempt,
      nextRetryMs,
      error,
      notifyUser,
    });

    clearRetryTimer();
    retryTimerCancel = options.processRuntime.setManagedTimeout(() => {
      retryTimerCancel = null;
      void ensureStarted("reconnecting");
    }, nextRetryMs);
  };

  const ensureStarted = (state: StellaBrowserBridgeState) => {
    if (launchPromise || stopped || options.processRuntime.isShuttingDown()) {
      return launchPromise ?? Promise.resolve();
    }

    options.onStatus({
      state,
      attempt: retryAttempt,
    });

    const currentService = new StellaBrowserBridgeService({
      frontendRoot: options.frontendRoot,
      onUnexpectedExit: (error) => {
        if (service !== currentService) {
          return;
        }
        service = null;
        scheduleReconnect(error);
      },
    });

    service = currentService;
    launchPromise = currentService.start()
      .then(() => {
        retryAttempt = 0;
        toastShownForCurrentOutage = false;
        options.onStatus({
          state: "connected",
          attempt: 0,
        });
      })
      .catch(async (error) => {
        if (service === currentService) {
          service = null;
        }
        await currentService.stop().catch(() => undefined);
        scheduleReconnect(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        launchPromise = null;
      });

    return launchPromise;
  };

  return {
    start: () => {
      stopped = false;
      if (service || launchPromise || options.processRuntime.isShuttingDown()) {
        return;
      }
      void ensureStarted("connecting");
    },
    stop: async () => {
      stopped = true;
      clearRetryTimer();
      await stopService();
    },
  };
};
