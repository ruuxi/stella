import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRuntime } from "../../../electron/process-runtime.js";

const mockState = vi.hoisted(() => ({
  bridge: null as any,
  tunnel: null as any,
}));

vi.mock("../../../electron/services/mobile-bridge/service.js", () => ({
  MobileBridgeService: class MockMobileBridgeService {
    port: number | null = null;
    broadcastToMobile = vi.fn();
    getPort = vi.fn(() => this.port);
    setBootstrapPayloadGetter = vi.fn();
    setConvexSiteUrl = vi.fn();
    setDeviceId = vi.fn();
    setHostAuthToken = vi.fn();
    setTunnelUrl = vi.fn();
    start = vi.fn();
    stop = vi.fn();

    constructor() {
      mockState.bridge = this;
    }
  },
}));

vi.mock(
  "../../../electron/process-resources/cloudflare-tunnel-resource.js",
  () => ({
    createCloudflareTunnelResource: vi.fn(() => {
      const tunnel = {
        setBridgePort: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      };
      mockState.tunnel = tunnel;
      return tunnel;
    }),
  }),
);

import { createMobileBridgeResource } from "../../../electron/process-resources/mobile-bridge-resource.js";

describe("mobile bridge resource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.bridge = null;
    mockState.tunnel = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("owns bridge auth sync, tunnel startup, and cleanup", async () => {
    const runtime = new ProcessRuntime();
    const fullWindow = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: {
        send: vi.fn(),
      },
    };

    const resource = createMobileBridgeResource({
      electronDir: "C:\\temp\\electron",
      isDev: true,
      getAuthToken: async () => "token-123",
      getBootstrapPayload: async () => ({ localStorage: {} }),
      getConvexSiteUrl: () => "https://site.test",
      getDeviceId: () => "device-123",
      getDevServerUrl: () => "http://localhost:5173",
      getFullWindow: () => fullWindow as never,
      processRuntime: runtime,
    });

    resource.start();
    await Promise.resolve();

    expect(mockState.bridge).toBeTruthy();
    expect(mockState.tunnel).toBeTruthy();
    expect(mockState.bridge.setBootstrapPayloadGetter).toHaveBeenCalledTimes(1);
    expect(mockState.bridge.setDeviceId).toHaveBeenCalledWith("device-123");
    expect(mockState.bridge.setHostAuthToken).toHaveBeenCalledWith("token-123");
    expect(mockState.bridge.setConvexSiteUrl).toHaveBeenCalledWith(
      "https://site.test",
    );

    mockState.bridge.port = 4312;
    await vi.advanceTimersByTimeAsync(500);

    expect(mockState.tunnel.setBridgePort).toHaveBeenCalledWith(4312);
    expect(mockState.tunnel.start).toHaveBeenCalledTimes(1);

    resource.broadcastToMobile("projects:changed", { ok: true });
    expect(mockState.bridge.broadcastToMobile).toHaveBeenCalledWith(
      "projects:changed",
      { ok: true },
    );

    await resource.stop();

    expect(mockState.tunnel.stop).toHaveBeenCalledTimes(1);
    expect(mockState.bridge.stop).toHaveBeenCalledTimes(1);
  });
});
