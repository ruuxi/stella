import { afterEach, describe, expect, it, vi } from "vitest";

import { StellaRuntimeHost } from "../../../../runtime/host/index.js";

describe("runtime host device identity recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rotates and re-registers when a heartbeat reports a device key mismatch", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const oldIdentity = { deviceId: "old-device", publicKey: "old-public" };
    const newIdentity = { deviceId: "new-device", publicKey: "new-public" };
    const resetDeviceIdentity = vi.fn().mockResolvedValue(newIdentity);
    const mutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if ("signedAtMs" in args) {
        throw {
          data: {
            code: "UNAUTHORIZED",
            message: "Device key mismatch for this machine.",
          },
        };
      }
      return null;
    });

    const host = new StellaRuntimeHost({
      hostHandlers: {
        getDeviceIdentity: async () => oldIdentity,
        resetDeviceIdentity,
        signHeartbeatPayload: async () => ({
          publicKey: oldIdentity.publicKey,
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "test",
          label: "Test",
        }),
        displayUpdate: () => undefined,
      },
      initializeParams: {
        clientName: "test-client",
        clientVersion: "0.0.0",
        isDev: false,
        platform: process.platform,
        stellaAppDir: "/tmp/stella-test",
        stellaDataDirPath: "/tmp/stella-test-home",
        stellaWorkspacePath: "/tmp/stella-test/workspace",
      },
    });
    const anyHost = host as any;
    const bridge = { start: vi.fn(), stop: vi.fn(), kick: vi.fn() };
    anyHost.configCache = {
      authToken: "token",
      convexUrl: "https://example.convex.cloud",
      hasConnectedAccount: true,
    };
    anyHost.deviceIdentity = oldIdentity;
    anyHost.ensureHostConvexClient = vi.fn(() => ({ mutation }));
    anyHost.ensureHostRemoteTurnBridge = vi.fn(() => {
      anyHost.hostRemoteTurnBridge = bridge;
    });
    anyHost.ensureHostRemoteTurnCancelSubscription = vi.fn();
    anyHost.registerHostDevice = vi.fn(async () => {
      anyHost.hostDeviceRegistered = true;
    });
    anyHost.startHostHeartbeatLoop = vi.fn();
    anyHost.scheduleRuntimeReload = vi.fn();
    anyHost.getActiveRun = vi.fn(async () => null);
    anyHost.health = vi.fn(async () => ({
      ready: true,
      hostPid: 1,
      workerPid: null,
      workerRunning: false,
      workerGeneration: 0,
      deviceId: newIdentity.deviceId,
      activeRunId: null,
      activeAgentCount: 0,
    }));

    await anyHost.sendHostHeartbeat();

    expect(resetDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(anyHost.deviceIdentity).toEqual(newIdentity);
    expect(anyHost.registerHostDevice).toHaveBeenCalledTimes(1);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(bridge.kick).toHaveBeenCalledTimes(1);
    expect(anyHost.scheduleRuntimeReload).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      deviceId: oldIdentity.deviceId,
    });

    vi.clearAllTimers();
    warn.mockRestore();
  });
});
