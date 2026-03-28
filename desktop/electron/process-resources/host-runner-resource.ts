import type { ProcessRuntime } from "../process-runtime.js";
import { createManagedResource } from "../managed-resource.js";

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
  const resource = createManagedResource<null>({
    processRuntime: options.processRuntime,
    canStart: () => !options.isQuitting(),
    create: () => null,
    start: () => options.initializeHostRunner(),
    stop: async () => {},
    oneShot: true,
    retry: { fixedDelayMs: BACKGROUND_RUNTIME_RETRY_DELAY_MS },
    onStarted: () => {
      options.processRuntime.setManagedTimeout(() => {
        if (!options.isQuitting()) options.onHostRunnerReady();
      }, POST_WINDOW_AUX_START_DELAY_MS);
    },
    onError: (error) => {
      console.error("[startup] Failed to initialize Stella host runner:", error);
    },
  });

  return { start: resource.start };
};
