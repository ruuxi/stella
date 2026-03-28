import type { BrowserWindow } from "electron";
import type { MobileBridgeBootstrap } from "../services/mobile-bridge/bootstrap-payload.js";
import { isMobileBridgeEventChannel } from "../services/mobile-bridge/index.js";
import { MobileBridgeService } from "../services/mobile-bridge/service.js";
import type { ProcessRuntime } from "../process-runtime.js";
import {
  createCloudflareTunnelResource,
  type CloudflareTunnelResource,
} from "./cloudflare-tunnel-resource.js";

const AUTH_SYNC_INTERVAL_MS = 30_000;
const WINDOW_RETRY_DELAY_MS = 1_000;
const PORT_RETRY_DELAY_MS = 500;

export type MobileBridgeResource = {
  broadcastToMobile: (channel: string, data: unknown) => void;
  start: () => void;
  stop: () => Promise<void>;
};

export const createMobileBridgeResource = (options: {
  electronDir: string;
  isDev: boolean;
  getAuthToken: () => Promise<string | null>;
  getBootstrapPayload: () => Promise<MobileBridgeBootstrap>;
  getConvexSiteUrl: () => string | null;
  getDeviceId: () => string | null;
  getDevServerUrl: () => string;
  getFullWindow: () => BrowserWindow | null;
  processRuntime: ProcessRuntime;
}): MobileBridgeResource => {
  let bridge: MobileBridgeService | null = null;
  let tunnel: CloudflareTunnelResource | null = null;
  let stopped = true;
  let bridgePort: number | null = null;
  let authSyncCancel: (() => void) | null = null;
  let portWaitCancel: (() => void) | null = null;
  let windowRetryCancel: (() => void) | null = null;
  let mirroredWindow: BrowserWindow | null = null;
  let restoreWindowSend: (() => void) | null = null;

  const clearAuthSync = () => {
    authSyncCancel?.();
    authSyncCancel = null;
  };

  const clearPortWait = () => {
    portWaitCancel?.();
    portWaitCancel = null;
  };

  const clearWindowRetry = () => {
    windowRetryCancel?.();
    windowRetryCancel = null;
  };

  const clearWindowMirror = () => {
    restoreWindowSend?.();
    restoreWindowSend = null;
    mirroredWindow = null;
  };

  const syncBridgeAuth = async () => {
    if (!bridge) {
      return;
    }

    bridge.setDeviceId(options.getDeviceId());
    bridge.setHostAuthToken(await options.getAuthToken());
    bridge.setConvexSiteUrl(options.getConvexSiteUrl());
  };

  const attachWindowMirror = () => {
    clearWindowRetry();

    if (stopped || options.processRuntime.isShuttingDown() || !bridge) {
      return;
    }

    const window = options.getFullWindow();
    if (!window || window.isDestroyed()) {
      windowRetryCancel = options.processRuntime.setManagedTimeout(
        attachWindowMirror,
        WINDOW_RETRY_DELAY_MS,
      );
      return;
    }

    if (mirroredWindow === window) {
      return;
    }

    clearWindowMirror();

    const originalSend = window.webContents.send.bind(window.webContents);
    window.webContents.send = ((channel: string, ...args: unknown[]) => {
      originalSend(channel, ...args);
      if (isMobileBridgeEventChannel(channel)) {
        bridge?.broadcastToMobile(channel, args.length === 1 ? args[0] : args);
      }
    }) as typeof window.webContents.send;

    mirroredWindow = window;
    restoreWindowSend = () => {
      if (!window.isDestroyed()) {
        window.webContents.send = originalSend as typeof window.webContents.send;
      }
      mirroredWindow = null;
    };

    window.once("closed", () => {
      if (mirroredWindow === window) {
        restoreWindowSend = null;
        mirroredWindow = null;
      }
      if (!stopped && !options.processRuntime.isShuttingDown()) {
        windowRetryCancel = options.processRuntime.setManagedTimeout(
          attachWindowMirror,
          WINDOW_RETRY_DELAY_MS,
        );
      }
    });
  };

  const waitForBridgePort = () => {
    clearPortWait();

    if (stopped || options.processRuntime.isShuttingDown() || !bridge) {
      return;
    }

    const port = bridge.getPort();
    if (port) {
      if (bridgePort === port) {
        return;
      }
      bridgePort = port;
      tunnel?.setBridgePort(port);
      tunnel?.start();
      return;
    }

    portWaitCancel = options.processRuntime.setManagedTimeout(
      waitForBridgePort,
      PORT_RETRY_DELAY_MS,
    );
  };

  const startBridge = () => {
    if (bridge || options.processRuntime.isShuttingDown()) {
      return;
    }

    bridge = new MobileBridgeService({
      electronDir: options.electronDir,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
    });
    bridge.setBootstrapPayloadGetter(options.getBootstrapPayload);
    bridge.start();

    authSyncCancel = options.processRuntime.setManagedInterval(() => {
      void syncBridgeAuth();
    }, AUTH_SYNC_INTERVAL_MS);
    void syncBridgeAuth();

    attachWindowMirror();
    waitForBridgePort();
  };

  return {
    broadcastToMobile: (channel, data) => {
      bridge?.broadcastToMobile(channel, data);
    },
    start: () => {
      stopped = false;
      if (bridge || options.processRuntime.isShuttingDown()) {
        return;
      }
      bridgePort = null;
      tunnel = createCloudflareTunnelResource({
        processRuntime: options.processRuntime,
        getAuthToken: options.getAuthToken,
        getConvexSiteUrl: options.getConvexSiteUrl,
        onTunnelUrl: (url) => {
          bridge?.setTunnelUrl(url);
        },
      });
      startBridge();
    },
    stop: async () => {
      stopped = true;
      clearAuthSync();
      clearPortWait();
      clearWindowRetry();
      clearWindowMirror();
      await tunnel?.stop();
      tunnel = null;
      bridge?.stop();
      bridge = null;
      bridgePort = null;
    },
  };
};
