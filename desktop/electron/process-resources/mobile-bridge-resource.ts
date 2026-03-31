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
const MOBILE_SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
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
  let sessionId = 0;
  let stopAuthSync: (() => void) | null = null;
  let stopSessionTimer: (() => void) | null = null;
  let mirroredWindow: BrowserWindow | null = null;
  let restoreWindowSend: (() => void) | null = null;

  const createTunnel = () => {
    tunnel = createCloudflareTunnelResource({
      processRuntime: options.processRuntime,
      getAuthToken: options.getAuthToken,
      getConvexSiteUrl: options.getConvexSiteUrl,
      getDeviceId: options.getDeviceId,
      onTunnelUrl: (url) => {
        bridge?.setTunnelUrl(url);
      },
    });
  };

  const clearWindowMirror = () => {
    restoreWindowSend?.();
    restoreWindowSend = null;
    mirroredWindow = null;
  };

  const rearmSessionTimer = () => {
    stopSessionTimer?.();
    stopSessionTimer = options.processRuntime.setManagedTimeout(() => {
      void resource.stop();
    }, MOBILE_SESSION_IDLE_TIMEOUT_MS);
  };

  const isInactiveSession = (candidateSessionId: number) => {
    return (
      stopped ||
      sessionId !== candidateSessionId ||
      options.processRuntime.isShuttingDown() ||
      !bridge
    );
  };

  const syncBridgeAuth = async (candidateSessionId: number) => {
    if (isInactiveSession(candidateSessionId)) {
      return;
    }

    const activeBridge = bridge;
    if (!activeBridge) {
      return;
    }

    activeBridge.setDeviceId(options.getDeviceId());
    activeBridge.setHostAuthToken(await options.getAuthToken());
    activeBridge.setConvexSiteUrl(options.getConvexSiteUrl());
  };

  const attachWindowMirror = (candidateSessionId: number) => {
    if (isInactiveSession(candidateSessionId)) {
      return;
    }

    const window = options.getFullWindow();
    if (!window || window.isDestroyed()) {
      options.processRuntime.setManagedTimeout(() => {
        attachWindowMirror(candidateSessionId);
      }, WINDOW_RETRY_DELAY_MS);
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
        window.webContents.send =
          originalSend as typeof window.webContents.send;
      }
      mirroredWindow = null;
    };

    window.once("closed", () => {
      if (mirroredWindow === window) {
        restoreWindowSend = null;
        mirroredWindow = null;
      }
      if (!isInactiveSession(candidateSessionId)) {
        options.processRuntime.setManagedTimeout(() => {
          attachWindowMirror(candidateSessionId);
        }, WINDOW_RETRY_DELAY_MS);
      }
    });
  };

  const waitForBridgePort = (candidateSessionId: number) => {
    if (isInactiveSession(candidateSessionId)) {
      return;
    }

    const activeBridge = bridge;
    if (!activeBridge) {
      return;
    }

    const port = activeBridge.getPort();
    if (port) {
      tunnel?.setBridgePort(port);
      tunnel?.start();
      return;
    }

    options.processRuntime.setManagedTimeout(() => {
      waitForBridgePort(candidateSessionId);
    }, PORT_RETRY_DELAY_MS);
  };

  const startBridge = (candidateSessionId: number) => {
    if (bridge || options.processRuntime.isShuttingDown()) {
      return;
    }

    bridge = new MobileBridgeService({
      electronDir: options.electronDir,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      onClientActivity: rearmSessionTimer,
    });
    bridge.setBootstrapPayloadGetter(options.getBootstrapPayload);
    bridge.start();

    stopAuthSync = options.processRuntime.setManagedInterval(() => {
      void syncBridgeAuth(candidateSessionId);
    }, AUTH_SYNC_INTERVAL_MS);
    void syncBridgeAuth(candidateSessionId);

    attachWindowMirror(candidateSessionId);
    waitForBridgePort(candidateSessionId);
  };

  const resource: MobileBridgeResource = {
    broadcastToMobile: (channel, data) => {
      bridge?.broadcastToMobile(channel, data);
    },
    start: () => {
      stopped = false;
      rearmSessionTimer();
      if (bridge || options.processRuntime.isShuttingDown()) {
        return;
      }
      sessionId += 1;
      createTunnel();
      startBridge(sessionId);
    },
    stop: async () => {
      stopped = true;
      sessionId += 1;
      stopAuthSync?.();
      stopAuthSync = null;
      stopSessionTimer?.();
      stopSessionTimer = null;
      clearWindowMirror();
      await tunnel?.stop();
      tunnel = null;
      bridge?.stop();
      bridge = null;
    },
  };

  return resource;
};
