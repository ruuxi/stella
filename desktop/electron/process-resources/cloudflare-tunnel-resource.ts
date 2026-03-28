import { ProcessRuntime } from "../process-runtime.js";
import { CloudflareTunnelService } from "../services/mobile-bridge/tunnel-service.js";
import { createManagedResource } from "../managed-resource.js";

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
  let bridgePort: number | null = null;

  return createManagedResource<CloudflareTunnelService, { setBridgePort: (port: number) => void }>(
    {
      processRuntime: options.processRuntime,
      canStart: () => bridgePort !== null,
      create: ({ onUnexpectedExit }) =>
        new CloudflareTunnelService({
          getAuthToken: options.getAuthToken,
          getConvexSiteUrl: options.getConvexSiteUrl,
          onTunnelUrl: options.onTunnelUrl,
          onUnexpectedExit,
        }),
      setup: (s) => {
        if (bridgePort) s.setBridgePort(bridgePort);
      },
      start: (s) => s.start(),
      stop: (s) => s.stop(),
      onRetry: ({ attempt, delayMs, error }) => {
        console.log(
          `[cloudflare-tunnel] Restarting in ${delayMs}ms (attempt ${attempt})`,
        );
        console.error("[cloudflare-tunnel] Restart reason:", error);
      },
    },
    () => ({
      setBridgePort: (port: number) => {
        bridgePort = port;
      },
    }),
  );
};
