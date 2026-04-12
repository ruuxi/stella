import { afterEach, describe, expect, it, vi } from "vitest";
import { StellaRuntimeClient } from "../../../runtime/client/index.js";

const createClient = () =>
  new StellaRuntimeClient({
    hostHandlers: {
      uiSnapshot: async () => "",
      uiAct: async () => "",
      getDeviceIdentity: async () => ({ deviceId: "dev-device", publicKey: "pub" }),
      signHeartbeatPayload: async () => ({ publicKey: "pub", signature: "sig" }),
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
      stellaRoot: "/tmp/stella-test",
      stellaWorkspacePath: "/tmp/stella-test",
    },
  });

describe("runtime reload deferral", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a deferred worker restart when the run finishes", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const anyClient = client as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyClient.restartWorker = restartWorker;

    await anyClient.pauseRuntimeReloads("run-1");
    await anyClient.scheduleRuntimeReload("worker");

    expect(restartWorker).not.toHaveBeenCalled();

    await anyClient.resumeRuntimeReloads("run-1");
    await vi.runAllTimersAsync();

    expect(restartWorker).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple deferred worker restarts", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const anyClient = client as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyClient.restartWorker = restartWorker;

    await anyClient.pauseRuntimeReloads("run-2");
    await anyClient.scheduleRuntimeReload("worker");
    await anyClient.scheduleRuntimeReload("worker");

    await anyClient.resumeRuntimeReloads("run-2");
    await vi.runAllTimersAsync();

    expect(restartWorker).toHaveBeenCalledTimes(1);
  });
});
