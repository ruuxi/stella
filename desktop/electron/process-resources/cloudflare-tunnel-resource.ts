import { ProcessRuntime } from "../process-runtime.js";
import { CloudflareTunnelService } from "../services/mobile-bridge/tunnel-service.js";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

export type CloudflareTunnelResource = {
  setBridgePort: (port: number) => void;
  start: () => void;
  stop: () => Promise<void>;
};

export const createCloudflareTunnelResource = (options: {
  processRuntime: ProcessRuntime;
  getAuthToken: () => Promise<string | null>;
  getConvexSiteUrl: () => string | null;
  onTunnelUrl: (url: string | null) => void;
}): CloudflareTunnelResource => {
  let service: CloudflareTunnelService | null = null;
  let launchPromise: Promise<void> | null = null;
  let retryTimerCancel: (() => void) | null = null;
  let retryCount = 0;
  let bridgePort: number | null = null;
  let stopped = true;

  const clearRetryTimer = () => {
    retryTimerCancel?.();
    retryTimerCancel = null;
  };

  const stopService = async () => {
    const activeService = service;
    service = null;
    await activeService?.stop();
  };

  const scheduleRestart = (error: string) => {
    if (stopped || options.processRuntime.isShuttingDown()) {
      return;
    }

    const delayMs = Math.min(
      RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount),
      RETRY_MAX_DELAY_MS,
    );
    retryCount += 1;
    console.log(
      `[cloudflare-tunnel] Restarting in ${delayMs}ms (attempt ${retryCount})`,
    );
    console.error("[cloudflare-tunnel] Restart reason:", error);

    clearRetryTimer();
    retryTimerCancel = options.processRuntime.setManagedTimeout(() => {
      retryTimerCancel = null;
      void ensureStarted();
    }, delayMs);
  };

  const ensureStarted = () => {
    if (
      launchPromise ||
      stopped ||
      options.processRuntime.isShuttingDown() ||
      !bridgePort
    ) {
      return launchPromise ?? Promise.resolve();
    }

    const currentService = new CloudflareTunnelService({
      getAuthToken: options.getAuthToken,
      getConvexSiteUrl: options.getConvexSiteUrl,
      onTunnelUrl: options.onTunnelUrl,
      onUnexpectedExit: (error) => {
        if (service !== currentService) {
          return;
        }
        service = null;
        scheduleRestart(error);
      },
    });

    currentService.setBridgePort(bridgePort);
    service = currentService;
    launchPromise = currentService.start()
      .then(() => {
        retryCount = 0;
      })
      .catch(async (error) => {
        if (service === currentService) {
          service = null;
        }
        await currentService.stop().catch(() => undefined);
        scheduleRestart(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        launchPromise = null;
      });

    return launchPromise;
  };

  return {
    setBridgePort: (port: number) => {
      bridgePort = port;
    },
    start: () => {
      stopped = false;
      if (service || launchPromise || options.processRuntime.isShuttingDown()) {
        return;
      }
      void ensureStarted();
    },
    stop: async () => {
      stopped = true;
      clearRetryTimer();
      await stopService();
    },
  };
};
