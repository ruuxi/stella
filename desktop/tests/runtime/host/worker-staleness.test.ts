import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWorkerBusyForRestart,
  StellaRuntimeHost,
} from "../../../../runtime/host/index.js";
import { computeRuntimeBuildStamp } from "../../../../runtime/worker/runtime-build-stamp.js";
import { resolveRuntimePaths } from "../../../../runtime/worker/runtime-paths.js";

/**
 * Staleness handshake + idle/deferred restart tests. These drive the host's
 * private machinery directly (same style as reload-deferral.test.ts): the
 * "connection" objects are minimal fakes and restartWorker is stubbed.
 */

const tempDirs: string[] = [];
const runtimeRootDirs: string[] = [];
const hosts: StellaRuntimeHost[] = [];

const IDLE_HEALTH = {
  health: { ok: true },
  activeRun: null,
  activeAgentCount: 0,
  pid: 4242,
  deviceId: "dev-device",
};

const BUSY_HEALTH = {
  ...IDLE_HEALTH,
  activeRun: { runId: "run-busy", conversationId: "conv-1" },
};

const makeWorkerEntryTree = () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "stella-staleness-tree-"));
  tempDirs.push(base);
  const treeRoot = path.join(base, "runtime");
  mkdirSync(path.join(treeRoot, "worker"), { recursive: true });
  const entryPath = path.join(treeRoot, "worker", "entry.js");
  writeFileSync(entryPath, "// worker entry\n");
  return entryPath;
};

const createHost = (args: { stellaAppDir: string; workerEntryPath: string }) => {
  const host = new StellaRuntimeHost({
    workerEntryPath: args.workerEntryPath,
    hostHandlers: {
      getDeviceIdentity: async () => ({
        deviceId: "dev-device",
        publicKey: "pub",
      }),
      signHeartbeatPayload: async () => ({
        publicKey: "pub",
        signature: "sig",
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
      stellaAppDir: args.stellaAppDir,
      stellaDataDirPath: args.stellaAppDir,
      stellaWorkspacePath: args.stellaAppDir,
    },
  });
  hosts.push(host);
  const anyHost = host as any;
  anyHost.started = true;
  anyHost.restartWorker = vi.fn().mockResolvedValue({ ok: true });
  anyHost.getWorkerHealth = vi.fn().mockResolvedValue(IDLE_HEALTH);
  return anyHost;
};

const setupRoot = () => {
  const stellaAppDir = mkdtempSync(
    path.join(os.tmpdir(), "stella-staleness-root-"),
  );
  tempDirs.push(stellaAppDir);
  const paths = resolveRuntimePaths(stellaAppDir);
  mkdirSync(paths.rootDir, { recursive: true });
  runtimeRootDirs.push(paths.rootDir);
  return { stellaAppDir, paths };
};

const drain = async (anyHost: any) => {
  await anyHost.reloadQueue;
  // requestStaleWorkerRestart chains through the queue; settle microtasks.
  await Promise.resolve();
  await anyHost.reloadQueue;
};

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    (host as any).stopStaleWorkerQuiescencePoll?.();
  }
  for (const dir of runtimeRootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe("isWorkerBusyForRestart", () => {
  it("treats an unreachable worker as not busy", () => {
    expect(isWorkerBusyForRestart(null)).toBe(false);
  });

  it("flags active runs, spawned agents, and voice work as busy", () => {
    expect(
      isWorkerBusyForRestart({ activeRun: null, activeAgentCount: 0 } as any),
    ).toBe(false);
    expect(
      isWorkerBusyForRestart({
        activeRun: { runId: "r" },
        activeAgentCount: 0,
      } as any),
    ).toBe(true);
    expect(
      isWorkerBusyForRestart({ activeRun: null, activeAgentCount: 2 } as any),
    ).toBe(true);
    expect(
      isWorkerBusyForRestart({
        activeRun: null,
        activeAgentCount: 0,
        voiceBusy: true,
      } as any),
    ).toBe(true);
    expect(
      isWorkerBusyForRestart({
        activeRun: null,
        activeAgentCount: 0,
        pendingVoiceRequestCount: 1,
      } as any),
    ).toBe(true);
  });
});

describe("stale worker staleness handshake", () => {
  it("detects a build-stamp mismatch on reattach and restarts an idle worker", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(paths.buildStampFile, "stamp-from-an-older-build\n");
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart?.reason).toBe(
      "build-stamp-mismatch",
    );
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);

    // Idle path: the deferred kick runs through the quiescence check.
    await anyHost.maybeRestartStaleWorkerWhenQuiescent();
    await drain(anyHost);
    expect(anyHost.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("treats a missing worker stamp (pre-stamp worker) as stale", async () => {
    const { stellaAppDir } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart?.reason).toBe(
      "worker-stamp-missing",
    );
  });

  it("does not flag a reattached worker whose stamp matches the on-disk tree", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(
      paths.buildStampFile,
      `${computeRuntimeBuildStamp(workerEntryPath)}\n`,
    );
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart).toBeNull();
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(false);
    await drain(anyHost);
    expect(anyHost.restartWorker).not.toHaveBeenCalled();
  });

  it("defers the restart while busy and restarts once the worker goes quiescent", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(paths.buildStampFile, "stale-stamp\n");
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = BUSY_HEALTH;
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart?.reason).toBe(
      "build-stamp-mismatch",
    );
    // Busy: quiescence checks must not restart.
    await anyHost.maybeRestartStaleWorkerWhenQuiescent();
    await drain(anyHost);
    expect(anyHost.restartWorker).not.toHaveBeenCalled();

    // Run finishes -> worker reports idle -> restart fires.
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(IDLE_HEALTH);
    await anyHost.maybeRestartStaleWorkerWhenQuiescent();
    await drain(anyHost);
    expect(anyHost.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("re-checks busy-ness immediately before killing so a fresh run is never cut down", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(paths.buildStampFile, "stale-stamp\n");
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    // Quiescence check sees idle, but by the time the queued restart runs a
    // new run has started.
    anyHost.getWorkerHealth = vi
      .fn()
      .mockResolvedValueOnce(IDLE_HEALTH)
      .mockResolvedValue(BUSY_HEALTH);
    await anyHost.maybeRestartStaleWorkerWhenQuiescent();
    await drain(anyHost);
    expect(anyHost.restartWorker).not.toHaveBeenCalled();
    // Pending state survives for the next quiescent moment.
    expect(anyHost.pendingStaleWorkerRestart).not.toBeNull();
  });

  it("persists the pending flag so a new host (post Electron restart) picks it up", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHostA = createHost({ stellaAppDir, workerEntryPath });
    anyHostA.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);
    await anyHostA.noteRuntimeCodeChangedByApply("self-mod-apply-runtime-restart");
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);

    // "Electron restarts": a brand-new host attaches to the same worker.
    // The stamp matches (nothing rebuilt) but the flag forces staleness.
    writeFileSync(
      paths.buildStampFile,
      `${computeRuntimeBuildStamp(workerEntryPath)}\n`,
    );
    const anyHostB = createHost({ stellaAppDir, workerEntryPath });
    anyHostB.workerHealthCache = IDLE_HEALTH;
    await anyHostB.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });
    expect(anyHostB.pendingStaleWorkerRestart?.reason).toBe(
      "pending-restart-flag",
    );
    await anyHostB.maybeRestartStaleWorkerWhenQuiescent();
    await drain(anyHostB);
    expect(anyHostB.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("clears the pending flag when a freshly spawned worker connects", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);
    await anyHost.noteRuntimeCodeChangedByApply("self-mod-apply-runtime-restart");
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4243,
      attachedToExistingWorker: false,
    });

    expect(anyHost.pendingStaleWorkerRestart).toBeNull();
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(false);
  });

  it("marks pending and restarts immediately for an idle runtime-relevant apply", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });

    vi.useFakeTimers();
    await anyHost.noteRuntimeCodeChangedByApply(
      "self-mod-apply-process-restart",
    );
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    vi.useRealTimers();
    await drain(anyHost);
    expect(anyHost.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("reports pendingWorkerRestart in the health snapshot", async () => {
    const { stellaAppDir } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);

    expect((await anyHost.health()).pendingWorkerRestart).toBeUndefined();
    await anyHost.noteRuntimeCodeChangedByApply("self-mod-apply-runtime-restart");
    expect((await anyHost.health()).pendingWorkerRestart).toBe(true);
  });
});
