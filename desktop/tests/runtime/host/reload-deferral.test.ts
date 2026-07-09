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
      stellaAppDir: "/tmp/stella-test",
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
    // The unified restart gate only runs on a started host.
    anyHost.started = true;

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
    // The unified restart gate only runs on a started host.
    anyHost.started = true;

    await anyHost.pauseRuntimeReloads("run-2");
    await anyHost.scheduleRuntimeReload("worker");
    await anyHost.scheduleRuntimeReload("worker");

    await anyHost.resumeRuntimeReloads("run-2");
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;

    expect(restartWorker).toHaveBeenCalledTimes(1);
  });

  it("defers a worker restart until an in-flight morph transition settles", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const anyHost = host as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyHost.restartWorker = restartWorker;
    // The unified restart gate only runs on a started host.
    anyHost.started = true;

    // Bracket a self-mod morph transition (as HOST_HMR_RUN_TRANSITION does).
    let releaseMorph: () => void = () => {};
    const morphDone = new Promise<void>((resolve) => {
      releaseMorph = resolve;
    });
    const transition = anyHost.withMorphTransitionInFlight(() => morphDone);

    // A dev-watcher runtime reload lands while the morph cover is on screen.
    // Restarting now would kill the worker mid `finishExternalSelfMod`, close
    // the RPC transport, and force a redundant SECOND morph via the update
    // handler's transport-closed reload-replay. It must be held.
    await anyHost.scheduleRuntimeReload("worker");
    await vi.runAllTimersAsync();
    expect(restartWorker).not.toHaveBeenCalled();
    expect(anyHost.deferredRuntimeReload).toBe(true);

    // Once the cover lifts, the held restart flushes exactly once.
    releaseMorph();
    await transition;
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;

    expect(restartWorker).toHaveBeenCalledTimes(1);
    expect(anyHost.morphTransitionsInFlight).toBe(0);
  });

  it("defers a dev-watcher runtime reload while the worker is busy", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const anyHost = host as any;
    const restartWorker = vi.fn().mockResolvedValue({ ok: true });

    anyHost.restartWorker = restartWorker;
    anyHost.started = true;

    // The unified gate now applies the worker-busy deferral to the dev
    // dist-electron watcher path too (not just the stale-worker path), matching
    // the intended model: worker restart for runtime changes only when idle.
    let busy = true;
    anyHost.getWorkerHealth = vi.fn(async () =>
      busy
        ? {
            activeRun: { runId: "run-x" },
            activeAgentCount: 1,
            voiceBusy: false,
            pendingVoiceRequestCount: 0,
          }
        : {
            activeRun: null,
            activeAgentCount: 0,
            voiceBusy: false,
            pendingVoiceRequestCount: 0,
          },
    );

    // A runtime/ change lands while the worker is busy — held, not restarted.
    anyHost.scheduleRuntimeReload("worker");
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;
    expect(restartWorker).not.toHaveBeenCalled();
    expect(anyHost.deferredRuntimeReload).toBe(true);

    // Worker goes idle; the next flush (as a RUN_FINISHED / poll tick would
    // trigger) restarts exactly once.
    busy = false;
    await anyHost.flushWorkerRestart();
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
    // The unified restart gate only runs on a started host.
    anyHost.started = true;

    await anyHost.pauseRuntimeReloads("lost-run");
    await anyHost.scheduleRuntimeReload("worker");
    expect(restartWorker).not.toHaveBeenCalled();

    await anyHost.resetRuntimeReloadPauses();
    await vi.runAllTimersAsync();
    await anyHost.reloadQueue;

    expect(anyHost.pausedRuntimeReloadRuns.size).toBe(0);
    expect(restartWorker).toHaveBeenCalledTimes(1);
  });

  it("clears runtime-reload pauses held by runs that died with the restarted worker", async () => {
    const host = createHost();
    const anyHost = host as any;
    anyHost.workerController = {
      stop: vi.fn().mockResolvedValue(undefined),
      ensureStarted: vi.fn().mockResolvedValue(undefined),
    };

    // A self-mod / desktop-update run paused reloads, then the worker was
    // restarted out from under it (e.g. an update shipping runtime code).
    // The run can never send its resume — the pause must not leak.
    await anyHost.pauseRuntimeReloads("update-run");
    anyHost.deferredRuntimeReload = true;
    expect(anyHost.pausedRuntimeReloadRuns.size).toBe(1);

    await host.restartWorker();

    expect(anyHost.pausedRuntimeReloadRuns.size).toBe(0);
    expect(anyHost.deferredRuntimeReload).toBe(false);
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
