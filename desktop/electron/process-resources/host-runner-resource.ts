import type { ProcessRuntime } from "../process-runtime.js";

const BACKGROUND_RUNTIME_RETRY_DELAY_MS = 2_000;
const POST_WINDOW_AUX_START_DELAY_MS = 1_500;

export type HostRunnerResource = {
  start: () => void;
};

export const createHostRunnerResource = (options: {
  processRuntime: ProcessRuntime;
  isQuitting: () => boolean;
  initializeHostRunner: () => Promise<void>;
  onHostRunnerReady: () => void;
}): HostRunnerResource => {
  let launchPromise: Promise<void> | null = null;
  let started = false;

  const scheduleRetry = () => {
    options.processRuntime.setManagedTimeout(() => {
      void ensureStarted();
    }, BACKGROUND_RUNTIME_RETRY_DELAY_MS);
  };

  const scheduleReadyCallback = () => {
    options.processRuntime.setManagedTimeout(() => {
      if (options.isQuitting()) {
        return;
      }
      options.onHostRunnerReady();
    }, POST_WINDOW_AUX_START_DELAY_MS);
  };

  const ensureStarted = () => {
    if (
      started
      || launchPromise
      || options.isQuitting()
      || options.processRuntime.isShuttingDown()
    ) {
      return launchPromise ?? Promise.resolve();
    }

    launchPromise = options.initializeHostRunner()
      .then(() => {
        started = true;
        scheduleReadyCallback();
      })
      .catch((error) => {
        console.error(
          "[startup] Failed to initialize Stella host runner:",
          (error as Error).message,
        );
        if (!options.isQuitting() && !options.processRuntime.isShuttingDown()) {
          scheduleRetry();
        }
      })
      .finally(() => {
        launchPromise = null;
      });

    return launchPromise;
  };

  return {
    start: () => {
      void ensureStarted();
    },
  };
};
