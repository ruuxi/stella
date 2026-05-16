import { afterEach, describe, expect, it, vi } from "vitest";
import { StellaRuntimeHost } from "../../../../runtime/host/index.js";
import { METHOD_NAMES } from "../../../../runtime/protocol/index.js";

const createHost = () =>
  new StellaRuntimeHost({
    hostHandlers: {
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
    const host = createHost();
    const anyHost = host as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyHost.restartWorker = restartWorker;

    await anyHost.pauseRuntimeReloads("run-1");
    await anyHost.scheduleRuntimeReload("worker");

    expect(restartWorker).not.toHaveBeenCalled();

    await anyHost.resumeRuntimeReloads("run-1");
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;

    expect(restartWorker).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple deferred worker restarts", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const anyHost = host as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyHost.restartWorker = restartWorker;

    await anyHost.pauseRuntimeReloads("run-2");
    await anyHost.scheduleRuntimeReload("worker");
    await anyHost.scheduleRuntimeReload("worker");

    await anyHost.resumeRuntimeReloads("run-2");
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;

    expect(restartWorker).toHaveBeenCalledTimes(1);
  });

  it("clears leaked runtime reload pauses when the worker initializes again", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const anyHost = host as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyHost.restartWorker = restartWorker;

    await anyHost.pauseRuntimeReloads("lost-run");
    await anyHost.scheduleRuntimeReload("worker");
    expect(restartWorker).not.toHaveBeenCalled();

    await anyHost.resetRuntimeReloadPauses();
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;

    expect(anyHost.pausedRuntimeReloadRuns.size).toBe(0);
    expect(restartWorker).toHaveBeenCalledTimes(1);
  });

  it("echoes internal runIds for stale cleanup but emits HMR state for visible root run ids", async () => {
    const host = createHost();
    const anyHost = host as any;
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const peer = {
      registerRequestHandler: (name: string, handler: (params: unknown) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    };
    const requestWorker = vi.fn(async () => ({ ok: false, reason: "unknown-transition" }));
    const hmrStateEvents: Array<{ runId?: string; state: unknown }> = [];
    host.on("run-self-mod-hmr-state", (event) => {
      hmrStateEvents.push(event);
    });
    anyHost.requestWorker = requestWorker;
    anyHost.registerHostHandlers(peer);
    anyHost.options.hostHandlers.runHmrTransition = async ({
      applyBatch,
      reportState,
    }: any) => {
      await reportState({ phase: "applying", paused: false, requiresFullReload: false });
      await applyBatch();
    };

    await expect(
      handlers.get(METHOD_NAMES.HOST_HMR_RUN_TRANSITION)!({
        transitionId: "transition-1",
        runIds: ["run-a", "run-b"],
        stateRunIds: ["root-run-a", "root-run-b"],
        requiresFullReload: false,
      }),
    ).rejects.toThrow("Self-mod HMR apply failed: unknown-transition");

    expect(requestWorker).toHaveBeenCalledWith(
      METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR,
      {
        transitionId: "transition-1",
        runIds: ["run-a", "run-b"],
      },
      { ensureWorker: false, recordActivity: true },
    );
    expect(hmrStateEvents).toEqual([
      {
        runId: "root-run-a",
        state: { phase: "applying", paused: false, requiresFullReload: false },
      },
      {
        runId: "root-run-b",
        state: { phase: "applying", paused: false, requiresFullReload: false },
      },
    ]);
  });
});
