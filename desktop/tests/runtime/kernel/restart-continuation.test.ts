import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RESTART_CONTINUATION_MAX_RECORD_AGE_MS,
  RESTART_CONTINUATION_RECORD_FILE,
  RESTART_EPISODE_MAX_AGE_MS,
  RESTART_EPISODE_WINDOW_MS,
  RESTART_INTERRUPTED_SNAPSHOT_FILE,
  RESTART_INTERRUPTION_STATE_FILE,
  attachRestartReminderForConversation,
  buildRestartReminderText,
  convertRestartShutdownRecordAtBoot,
  describeCurrentThreadState,
  fireRestartContinuationTurn,
  isRestartContinuationEnabled,
  isRestartContinuationTurnEnabled,
  peekRestartShutdownRecord,
  readRestartInterruptedSnapshot,
  readRestartInterruptionState,
  recordRestartShutdown,
  resolveRestartReminderOutcome,
  writeRestartInterruptedSnapshot,
  writeRestartShutdownRecord,
  type RestartContinuationFireDeps,
  type RestartThreadRecordLike,
  type ThreadStateSentinels,
} from "../../../../runtime/kernel/restart-continuation.js";
import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
  LocalAgentManager,
} from "../../../../runtime/kernel/agents/local-agent-manager.js";
import type { PersistedAgentRecord } from "../../../../runtime/kernel/storage/session-store.js";
import { createRestartContinuationReminderHooks } from "../../../../runtime/extensions/stella-runtime/hooks/restart-continuation-reminder.hook.js";

const sentinels: ThreadStateSentinels = {
  pausedReasons: [AGENT_PAUSE_CANCEL_REASON],
  restartCancelReasons: [
    AGENT_ORPHANED_RESTART_CANCEL_REASON,
    AGENT_SHUTDOWN_CANCEL_REASON,
  ],
};

const makeRecordRow = (
  overrides: Partial<RestartThreadRecordLike> & { threadId: string },
): RestartThreadRecordLike => ({
  conversationId: "conv-1",
  agentType: "general",
  description: "Refactor the parser",
  status: "canceled",
  error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
  updatedAt: Date.now(),
  ...overrides,
});

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-continuation-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const recordFilePath = () =>
  path.join(dataDir, RESTART_CONTINUATION_RECORD_FILE);
const stateFilePath = () => path.join(dataDir, RESTART_INTERRUPTION_STATE_FILE);
const snapshotFilePath = () =>
  path.join(dataDir, RESTART_INTERRUPTED_SNAPSHOT_FILE);

const writeFreshRecord = (reason = "self-mod-apply-process-restart") => {
  expect(writeRestartShutdownRecord(dataDir, { reason })).toBe(true);
};

const convert = (
  interruptedThreads: Array<{ threadId: string; conversationId: string }>,
  options?: {
    env?: Record<string, string | undefined>;
    now?: number;
    capturedEpisodeId?: string | null;
  },
) =>
  convertRestartShutdownRecordAtBoot({
    stellaDataDir: dataDir,
    env: options?.env ?? {},
    interruptedThreads,
    // Default mimics the real same-boot flow: the sweep captured under the
    // record currently on disk. Failure-boundary tests pass explicit values.
    capturedEpisodeId:
      options && "capturedEpisodeId" in options
        ? (options.capturedEpisodeId ?? null)
        : (peekRestartShutdownRecord(dataDir)?.episodeId ?? null),
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });

const attach = (conversationId: string, runId?: string) =>
  attachRestartReminderForConversation(dataDir, {
    conversationId,
    ...(runId ? { runId } : {}),
  });

describe("restart continuation gating", () => {
  it("is enabled by default and disabled via env flags", () => {
    expect(isRestartContinuationEnabled({})).toBe(true);
    expect(
      isRestartContinuationEnabled({
        STELLA_DISABLE_RESTART_CONTINUATION: "1",
      }),
    ).toBe(false);
    expect(
      isRestartContinuationEnabled({
        STELLA_DISABLE_RESTART_CONTINUATION: "false",
      }),
    ).toBe(true);
    expect(isRestartContinuationTurnEnabled({})).toBe(true);
    expect(
      isRestartContinuationTurnEnabled({
        STELLA_DISABLE_RESTART_CONTINUATION_TURN: "1",
      }),
    ).toBe(false);
    // Master switch also disables the turn.
    expect(
      isRestartContinuationTurnEnabled({
        STELLA_DISABLE_RESTART_CONTINUATION: "true",
      }),
    ).toBe(false);
  });
});

describe("shutdown record", () => {
  it("writes on restart initiation and is consumed exactly once by conversion", () => {
    writeFreshRecord("runtime-reload");
    expect(fs.existsSync(recordFilePath())).toBe(true);
    const state = convert([{ threadId: "t", conversationId: "conv-1" }]);
    expect(state?.reason).toBe("runtime-reload");
    expect(fs.existsSync(recordFilePath())).toBe(false);
    // Second boot: no record → nothing.
    expect(convert([{ threadId: "t", conversationId: "conv-1" }])).toBeNull();
  });

  it("keeps the earliest reason and episode id but refreshes the timestamp within one episode", () => {
    const t0 = Date.now() - 30_000;
    expect(
      recordRestartShutdown(dataDir, {
        reason: "self-mod-apply-process-restart",
        now: t0,
      }),
    ).toBe(true);
    const original = peekRestartShutdownRecord(dataDir);
    // stop() moments later with the generic label: reason and episode id
    // preserved, createdAt refreshed to the actual shutdown moment.
    const t1 = t0 + 5_000;
    expect(
      recordRestartShutdown(dataDir, { reason: "app-shutdown", now: t1 }),
    ).toBe(true);
    const merged = peekRestartShutdownRecord(dataDir);
    expect(merged?.reason).toBe("self-mod-apply-process-restart");
    expect(merged?.createdAt).toBe(t1);
    expect(merged?.episodeId).toBe(original?.episodeId);
  });

  it("replaces a leftover record from an older episode outright, minting a new id", () => {
    const old = Date.now() - RESTART_EPISODE_WINDOW_MS - 60_000;
    expect(
      recordRestartShutdown(dataDir, { reason: "runtime-reload", now: old }),
    ).toBe(true);
    const stale = peekRestartShutdownRecord(dataDir);
    // A record that survived a host relaunch without an intervening boot
    // must not mislabel the newer restart or poison staleness.
    const now = Date.now();
    expect(
      recordRestartShutdown(dataDir, { reason: "app-shutdown", now }),
    ).toBe(true);
    const replaced = peekRestartShutdownRecord(dataDir);
    expect(replaced?.reason).toBe("app-shutdown");
    expect(replaced?.createdAt).toBe(now);
    expect(replaced?.episodeId).not.toBe(stale?.episodeId);
    // And conversion still treats it as fresh.
    expect(
      convert([{ threadId: "t", conversationId: "conv-1" }], { now }),
    ).not.toBeNull();
  });

  it("caps episode chaining at an absolute max age from the first createdAt", () => {
    const now = Date.now();
    // An episode that has been merge-forwarded for longer than the cap:
    // last write is recent (within the merge window), but the episode
    // started past the absolute max age.
    expect(
      writeRestartShutdownRecord(dataDir, {
        reason: "runtime-reload",
        episodeId: "episode-old",
        now: now - 60_000,
        episodeStartedAt: now - RESTART_EPISODE_MAX_AGE_MS - 1_000,
      }),
    ).toBe(true);
    expect(
      recordRestartShutdown(dataDir, { reason: "app-shutdown", now }),
    ).toBe(true);
    const rolled = peekRestartShutdownRecord(dataDir);
    // The stale episode expires instead of rolling forever.
    expect(rolled?.episodeId).not.toBe("episode-old");
    expect(rolled?.reason).toBe("app-shutdown");
    expect(rolled?.episodeStartedAt).toBe(now);
    // Boundary: exactly AT the cap is no longer "younger than" — new id.
    expect(
      writeRestartShutdownRecord(dataDir, {
        reason: "runtime-reload",
        episodeId: "episode-boundary",
        now: now - 60_000,
        episodeStartedAt: now - RESTART_EPISODE_MAX_AGE_MS,
      }),
    ).toBe(true);
    expect(
      recordRestartShutdown(dataDir, { reason: "app-shutdown", now }),
    ).toBe(true);
    expect(peekRestartShutdownRecord(dataDir)?.episodeId).not.toBe(
      "episode-boundary",
    );
    // Within the cap the id chains normally.
    const chained = peekRestartShutdownRecord(dataDir);
    expect(
      recordRestartShutdown(dataDir, {
        reason: "runtime-reload",
        now: now + 60_000,
      }),
    ).toBe(true);
    expect(peekRestartShutdownRecord(dataDir)?.episodeId).toBe(
      chained?.episodeId,
    );
  });

  it("never merges forward onto a conversion-attempted (retained) record", () => {
    const now = Date.now();
    expect(
      writeRestartShutdownRecord(dataDir, {
        reason: "runtime-reload",
        episodeId: "episode-attempted",
        now: now - 30_000,
        attemptedAt: now - 20_000,
      }),
    ).toBe(true);
    // A new graceful shutdown moments later must start a fresh episode: the
    // retained record's shutdown was already swept on an earlier boot.
    expect(
      recordRestartShutdown(dataDir, { reason: "app-shutdown", now }),
    ).toBe(true);
    const next = peekRestartShutdownRecord(dataDir);
    expect(next?.episodeId).not.toBe("episode-attempted");
    expect(next?.reason).toBe("app-shutdown");
    expect(next?.attemptedAt).toBeUndefined();
  });
});

describe("boot conversion", () => {
  const threads = [
    { threadId: "thread-a", conversationId: "conv-1" },
    { threadId: "thread-b", conversationId: "conv-1" },
  ];

  it("converts a fresh record with interrupted work into interruption state", () => {
    writeFreshRecord();
    const state = convert(threads);
    expect(state).not.toBeNull();
    expect(state?.threads).toHaveLength(2);
    expect(readRestartInterruptionState(dataDir)?.reason).toBe(
      "self-mod-apply-process-restart",
    );
  });

  it("ignores stale records and produces no state (no turn, no reminder)", () => {
    writeFreshRecord();
    const state = convert(threads, {
      now: Date.now() + RESTART_CONTINUATION_MAX_RECORD_AGE_MS + 1,
    });
    expect(state).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
    expect(readRestartInterruptionState(dataDir)).toBeNull();
    expect(attach("conv-1")).toBeNull();
  });

  it("produces nothing when the shutdown was idle (no running threads)", () => {
    writeFreshRecord();
    expect(convert([])).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
  });

  it("produces nothing on a normal cold boot with no record", () => {
    expect(convert(threads)).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
  });

  it("is disabled by the master env switch and drops the record", () => {
    writeFreshRecord();
    expect(
      convert(threads, { env: { STELLA_DISABLE_RESTART_CONTINUATION: "1" } }),
    ).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
  });

  it("recovers when a previous boot crashed between state-write and record-delete", () => {
    // Boot 1: converted (state written) but died before deleting the record
    // — simulate by re-creating the record after conversion.
    writeFreshRecord("runtime-reload");
    const state = convert([{ threadId: "thread-a", conversationId: "conv-1" }]);
    expect(state).not.toBeNull();
    writeFreshRecord("runtime-reload");
    // Boot 2: the sweep already flipped the rows on boot 1, so the leftover
    // record converts via the idle rule — record consumed, state preserved.
    expect(convert([])).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
    expect(readRestartInterruptionState(dataDir)?.threads).toHaveLength(1);
  });

  it("does not reset bookkeeping when record+sidecar survive a crash after conversion", () => {
    writeFreshRecord("runtime-reload");
    const state = convert([{ threadId: "thread-a", conversationId: "conv-1" }]);
    expect(state).not.toBeNull();
    // Delivery bookkeeping exists before the simulated crash.
    expect(attach("conv-1", "run-1")).not.toBeNull();
    // Crash before cleanup left the SAME episode's record and sidecar (the
    // sidecar was written pre-flip while the record was unattempted; the
    // record carries the conversion-attempt latch).
    expect(
      writeRestartShutdownRecord(dataDir, {
        reason: "runtime-reload",
        now: state!.shutdownAt,
        episodeId: state!.episodeId,
      }),
    ).toBe(true);
    expect(
      writeRestartInterruptedSnapshot(dataDir, [
        { threadId: "thread-a", conversationId: "conv-1" },
      ]),
    ).toBe(state!.episodeId);
    expect(
      writeRestartShutdownRecord(dataDir, {
        reason: "runtime-reload",
        now: state!.shutdownAt,
        episodeId: state!.episodeId,
        attemptedAt: state!.shutdownAt,
      }),
    ).toBe(true);
    // Boot 2 (empty live snapshot): the same-episode check cleans up
    // without rewriting the state — bookkeeping survives.
    expect(convert([])).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
    expect(fs.existsSync(snapshotFilePath())).toBe(false);
    const preserved = readRestartInterruptionState(dataDir);
    expect(
      preserved?.conversations["conv-1"]?.reminderAttachedAt,
    ).toBeDefined();
  });

  it("never resurrects an older episode's sidecar under a newer record", () => {
    // Episode N: record + sidecar retained after a failed state write.
    writeFreshRecord("runtime-reload");
    expect(
      writeRestartInterruptedSnapshot(dataDir, [
        { threadId: "thread-old", conversationId: "conv-1" },
      ]),
    ).toBe(peekRestartShutdownRecord(dataDir)?.episodeId);
    // The app keeps running; a later graceful restart replaces the record
    // with episode N+1 (fresh id, fresh timestamp, different reason).
    const later = Date.now() + RESTART_EPISODE_WINDOW_MS + 60_000;
    expect(
      recordRestartShutdown(dataDir, { reason: "app-shutdown", now: later }),
    ).toBe(true);
    // Episode N+1 boots idle: the N-stamped sidecar must NOT be accepted as
    // evidence — no state, no resurrection; both artifacts cleaned up.
    expect(convert([], { now: later })).toBeNull();
    expect(readRestartInterruptionState(dataDir, later)).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
    expect(fs.existsSync(snapshotFilePath())).toBe(false);
  });

  it("converts a DISTINCT new episode even when timestamps collide to the millisecond", () => {
    const t = Date.now();
    // Episode A converts at timestamp t.
    writeFreshRecord("runtime-reload");
    const recordA = peekRestartShutdownRecord(dataDir);
    const stateA = convert(
      [{ threadId: "thread-a", conversationId: "conv-1" }],
      { now: t },
    );
    expect(stateA).not.toBeNull();
    // Episode B: new record sharing the exact millisecond, new identity,
    // with its own sidecar evidence for thread-b.
    expect(
      writeRestartShutdownRecord(dataDir, { reason: "app-shutdown", now: t }),
    ).toBe(true);
    const recordB = peekRestartShutdownRecord(dataDir);
    expect(recordB?.episodeId).not.toBe(recordA?.episodeId);
    expect(
      writeRestartInterruptedSnapshot(dataDir, [
        { threadId: "thread-b", conversationId: "conv-2" },
      ]),
    ).toBe(recordB?.episodeId);
    // The genuine new conversion proceeds (not suppressed by the guard).
    const stateB = convert([], { now: t });
    expect(stateB?.episodeId).toBe(recordB?.episodeId);
    expect(stateB?.threads).toEqual([
      { threadId: "thread-b", conversationId: "conv-2" },
    ]);
  });

  it("a retained record never absorbs a later crash boot's rows and its sidecar survives", () => {
    // Episode N: graceful shutdown while thread-a ran; conversion attempt
    // fails its state write → attempted record + N's sidecar retained.
    writeFreshRecord("runtime-reload");
    const episodeN = peekRestartShutdownRecord(dataDir)?.episodeId;
    const capturedN = writeRestartInterruptedSnapshot(dataDir, [
      { threadId: "thread-a", conversationId: "conv-1" },
    ]);
    expect(capturedN).toBe(episodeN);
    fs.mkdirSync(stateFilePath());
    expect(
      convert([{ threadId: "thread-a", conversationId: "conv-1" }], {
        capturedEpisodeId: capturedN,
      }),
    ).toBeNull();
    fs.rmdirSync(stateFilePath());
    expect(peekRestartShutdownRecord(dataDir)?.attemptedAt).toBeDefined();

    // The app keeps running, new agent work starts, then it HARD-CRASHES
    // (no new record). Next boot's sweep finds the fresh crash row.
    const crashCapture = writeRestartInterruptedSnapshot(dataDir, [
      { threadId: "thread-crash", conversationId: "conv-9" },
    ]);
    // The retained attempted record does not authorize the capture, and
    // N's retry sidecar is NOT clobbered by the crash row.
    expect(crashCapture).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
    // Conversion refuses the unauthorized live rows and recovers episode
    // N's REAL interruption from the preserved sidecar.
    const state = convert(
      [{ threadId: "thread-crash", conversationId: "conv-9" }],
      { capturedEpisodeId: crashCapture },
    );
    expect(state?.episodeId).toBe(episodeN);
    expect(state?.threads).toEqual([
      { threadId: "thread-a", conversationId: "conv-1" },
    ]);
  });

  it("refuses live rows when the record was swapped between capture and conversion", () => {
    // Sweep captures thread-a under episode N.
    writeFreshRecord("runtime-reload");
    const capturedN = writeRestartInterruptedSnapshot(dataDir, [
      { threadId: "thread-a", conversationId: "conv-1" },
    ]);
    expect(capturedN).toBe(peekRestartShutdownRecord(dataDir)?.episodeId);
    // The record is replaced by episode N+1 before conversion runs.
    expect(
      writeRestartShutdownRecord(dataDir, { reason: "app-shutdown" }),
    ).toBe(true);
    // Live rows captured under N are refused under N+1; the N-stamped
    // sidecar does not match either → no state, artifacts cleaned up.
    expect(
      convert([{ threadId: "thread-a", conversationId: "conv-1" }], {
        capturedEpisodeId: capturedN,
      }),
    ).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
    expect(fs.existsSync(snapshotFilePath())).toBe(false);
  });

  it("a fresh episode's capture replaces a dead sidecar from a superseded episode", () => {
    // Episode N's sidecar is on disk but N's record was superseded by a NEW
    // unattempted record (episode M): N's evidence is dead the moment its
    // record vanished, so M's capture must take the sidecar slot — it is
    // M's only next-boot retry evidence.
    writeFreshRecord("runtime-reload");
    const episodeN = peekRestartShutdownRecord(dataDir)?.episodeId;
    expect(
      writeRestartInterruptedSnapshot(dataDir, [
        { threadId: "thread-a", conversationId: "conv-1" },
      ]),
    ).toBe(episodeN);
    expect(
      writeRestartShutdownRecord(dataDir, { reason: "app-shutdown" }),
    ).toBe(true);
    const episodeM = peekRestartShutdownRecord(dataDir)?.episodeId;
    const captured = writeRestartInterruptedSnapshot(dataDir, [
      { threadId: "thread-m", conversationId: "conv-2" },
    ]);
    expect(captured).toBe(episodeM);
    const sidecar = readRestartInterruptedSnapshot(dataDir);
    expect(sidecar?.episodeId).toBe(episodeM);
    expect(sidecar?.threads).toEqual([
      { threadId: "thread-m", conversationId: "conv-2" },
    ]);
  });

  it("three-boot probe: a fresh episode after a failed one keeps its own retry evidence", () => {
    // Boot 1 / episode N: sweep captures thread-a, conversion's state write
    // fails → attempted N record + N sidecar retained.
    writeFreshRecord("runtime-reload");
    const episodeN = peekRestartShutdownRecord(dataDir)?.episodeId;
    const capturedN = writeRestartInterruptedSnapshot(dataDir, [
      { threadId: "thread-a", conversationId: "conv-1" },
    ]);
    expect(capturedN).toBe(episodeN);
    fs.mkdirSync(stateFilePath());
    expect(
      convert([{ threadId: "thread-a", conversationId: "conv-1" }], {
        capturedEpisodeId: capturedN,
      }),
    ).toBeNull();
    fs.rmdirSync(stateFilePath());

    // The app keeps running, new work starts, then a GRACEFUL shutdown
    // mints episode N+1 (attempted N is never merged forward).
    expect(recordRestartShutdown(dataDir, { reason: "app-shutdown" })).toBe(
      true,
    );
    const episodeN1 = peekRestartShutdownRecord(dataDir)?.episodeId;
    expect(episodeN1).not.toBe(episodeN);

    // Boot 2: sweep finds N+1's row and must WRITE N+1's sidecar over N's
    // dead one (N's record no longer exists — its evidence protects
    // nothing).
    const capturedN1 = writeRestartInterruptedSnapshot(dataDir, [
      { threadId: "thread-b", conversationId: "conv-2" },
    ]);
    expect(capturedN1).toBe(episodeN1);
    expect(readRestartInterruptedSnapshot(dataDir)?.episodeId).toBe(episodeN1);
    // N+1's conversion ALSO fails its state write.
    fs.mkdirSync(stateFilePath());
    expect(
      convert([{ threadId: "thread-b", conversationId: "conv-2" }], {
        capturedEpisodeId: capturedN1,
      }),
    ).toBeNull();
    fs.rmdirSync(stateFilePath());
    expect(peekRestartShutdownRecord(dataDir)?.attemptedAt).toBeDefined();

    // Boot 3: rows flipped, live snapshot empty — N+1 recovers from ITS
    // OWN matching sidecar instead of losing the continuation.
    const state = convert([], { capturedEpisodeId: null });
    expect(state?.episodeId).toBe(episodeN1);
    expect(state?.threads).toEqual([
      { threadId: "thread-b", conversationId: "conv-2" },
    ]);
  });

  it("keeps record AND sidecar when the state write fails (retry next boot)", () => {
    writeFreshRecord("runtime-reload");
    expect(
      writeRestartInterruptedSnapshot(dataDir, [
        { threadId: "thread-a", conversationId: "conv-1" },
      ]),
    ).toBe(peekRestartShutdownRecord(dataDir)?.episodeId);
    // Occupy the state path with a directory so the atomic rename fails.
    fs.mkdirSync(stateFilePath());
    const state = convert([{ threadId: "thread-a", conversationId: "conv-1" }]);
    expect(state).toBeNull();
    // Not silently lost: both retry artifacts survive for the next boot.
    expect(fs.existsSync(recordFilePath())).toBe(true);
    expect(fs.existsSync(snapshotFilePath())).toBe(true);
    fs.rmdirSync(stateFilePath());
  });

  it("two-boot probe: a failed state write on boot 1 still recovers on boot 2", async () => {
    // Graceful shutdown wrote the record while thread-a was running.
    writeFreshRecord("runtime-reload");
    const flipped: PersistedAgentRecord[] = [];
    const runningRow: PersistedAgentRecord = {
      threadId: "thread-a",
      conversationId: "conv-1",
      agentType: "general",
      description: "Refactor the parser",
      agentDepth: 1,
      status: "running",
      attemptGeneration: 0,
      startedAt: Date.now(),
      completedAt: null,
      updatedAt: Date.now(),
    };
    const makeManager = (running: PersistedAgentRecord[]) =>
      new LocalAgentManager({
        maxConcurrent: 1,
        listAgentRecordsByStatus: (status: string) =>
          status === "running" ? running : [],
        saveAgentRecord: (record: PersistedAgentRecord) => {
          flipped.push(record);
        },
        hasAgentLifecycleEvent: () => true,
        // Production wiring: sweep persists the pre-flip snapshot sidecar
        // and holds the episode id the capture was authorized under.
        persistBootInterruptionSnapshot: (
          threads: Array<{ threadId: string; conversationId: string }>,
        ) => writeRestartInterruptedSnapshot(dataDir, threads),
      } as unknown as ConstructorParameters<typeof LocalAgentManager>[0]);

    // Boot 1: sweep captures + flips the rows; the interruption-state write
    // fails (state path occupied by a directory).
    const boot1 = makeManager([runningRow]);
    expect(flipped.some((r) => r.threadId === "thread-a")).toBe(true);
    expect(boot1.getBootInterruptionEpisodeId()).toBe(
      peekRestartShutdownRecord(dataDir)?.episodeId,
    );
    fs.mkdirSync(stateFilePath());
    expect(
      convert(boot1.getBootInterruptedThreads(), {
        capturedEpisodeId: boot1.getBootInterruptionEpisodeId(),
      }),
    ).toBeNull();
    fs.rmdirSync(stateFilePath());
    expect(fs.existsSync(recordFilePath())).toBe(true);
    expect(fs.existsSync(snapshotFilePath())).toBe(true);

    // Boot 2: the rows were flipped on boot 1 — the live snapshot is EMPTY.
    const boot2 = makeManager([]);
    expect(boot2.getBootInterruptedThreads()).toEqual([]);
    expect(boot2.getBootInterruptionEpisodeId()).toBeNull();
    const state = convert(boot2.getBootInterruptedThreads(), {
      capturedEpisodeId: boot2.getBootInterruptionEpisodeId(),
    });
    expect(state?.threads).toEqual([
      { threadId: "thread-a", conversationId: "conv-1" },
    ]);
    expect(fs.existsSync(recordFilePath())).toBe(false);
    expect(fs.existsSync(snapshotFilePath())).toBe(false);

    // The reconstructed interruption drives both mechanisms.
    const turns: string[] = [];
    const fired = await fireRestartContinuationTurn({
      stellaDataDir: dataDir,
      env: {},
      sentinels,
      getAgentRecord: (threadId) =>
        threadId === "thread-a"
          ? makeRecordRow({ threadId: "thread-a" })
          : null,
      listAgentRecordsByStatus: () => [],
      appendLocalChatEvent: vi.fn(),
      runAutomationTurn: async (args) => {
        turns.push(args.userPrompt);
        return { status: "ok", finalText: "resumed" };
      },
    });
    expect(fired.outcomes["conv-1"]).toBe("completed");
    expect(turns[0]).toContain("thread-a");
    const reminder = attach("conv-1", "run-1");
    expect(reminder).not.toBeNull();
    expect(reminder?.turnCompleted).toBe(true);
  });

  it("tolerates malformed/partial JSON in both files without throwing", () => {
    fs.writeFileSync(recordFilePath(), '{"version":1,"reason":"tru', "utf8");
    fs.writeFileSync(stateFilePath(), "not json at all", "utf8");
    expect(peekRestartShutdownRecord(dataDir)).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
    // A torn record converts as a cold boot and is cleared.
    expect(convert([{ threadId: "t", conversationId: "conv-1" }])).toBeNull();
    expect(fs.existsSync(recordFilePath())).toBe(false);
  });
});

describe("boot-time continuation turn", () => {
  const rows = new Map<string, RestartThreadRecordLike>([
    ["thread-a", makeRecordRow({ threadId: "thread-a" })],
    [
      "thread-b",
      makeRecordRow({
        threadId: "thread-b",
        agentType: "general",
        description: "Coordinate the release",
        status: "completed",
        error: undefined,
        result: "Release shipped",
      }),
    ],
    [
      "thread-paused",
      makeRecordRow({
        threadId: "thread-paused",
        description: "Paused research",
        error: AGENT_PAUSE_CANCEL_REASON,
      }),
    ],
    [
      "thread-c",
      makeRecordRow({
        threadId: "thread-c",
        conversationId: "conv-2",
        description: "Second conversation task",
      }),
    ],
  ]);

  const makeDeps = (
    overrides?: Partial<RestartContinuationFireDeps>,
  ): RestartContinuationFireDeps & {
    appended: Array<{
      conversationId: string;
      payload: Record<string, unknown>;
    }>;
    turns: Array<{ conversationId: string; userPrompt: string }>;
  } => {
    const appended: Array<{
      conversationId: string;
      payload: Record<string, unknown>;
    }> = [];
    const turns: Array<{ conversationId: string; userPrompt: string }> = [];
    return {
      appended,
      turns,
      stellaDataDir: dataDir,
      env: {},
      sentinels,
      getAgentRecord: (threadId) => rows.get(threadId) ?? null,
      listAgentRecordsByStatus: (status) =>
        [...rows.values()].filter((row) => row.status === status),
      appendLocalChatEvent: (args) => {
        appended.push({
          conversationId: args.conversationId,
          payload: args.payload,
        });
      },
      runAutomationTurn: async (args) => {
        turns.push(args);
        return { status: "ok", finalText: "Resumed thread-a." };
      },
      ...overrides,
    };
  };

  const seedState = () => {
    writeFreshRecord();
    const state = convert([
      { threadId: "thread-a", conversationId: "conv-1" },
      { threadId: "thread-b", conversationId: "conv-1" },
    ]);
    expect(state).not.toBeNull();
  };

  it("fires exactly once with facts, paused-thread mentions, and chat notices", async () => {
    seedState();
    const deps = makeDeps();
    const result = await fireRestartContinuationTurn(deps);
    expect(result.fired).toBe(true);
    expect(result.conversationIds).toEqual(["conv-1"]);
    expect(result.outcomes["conv-1"]).toBe("completed");

    // Visible system-style notice + the orchestrator's final reply.
    expect(deps.appended).toHaveLength(2);
    expect(deps.appended[0].payload.text).toContain("Stella restarted");
    expect(deps.appended[1].payload.text).toBe("Resumed thread-a.");

    // One real orchestrator turn carrying the interruption facts.
    expect(deps.turns).toHaveLength(1);
    const prompt = deps.turns[0].userPrompt;
    expect(prompt).toContain("thread-a");
    expect(prompt).toContain("Refactor the parser");
    expect(prompt).toContain("resumable via send_input");
    expect(prompt).toContain("thread-b");
    expect(prompt).toContain("completed");
    // User-paused thread is mentioned but excluded from the resume list.
    expect(prompt).toContain("thread-paused");
    expect(prompt).toContain("do NOT resume");

    // Completion recorded only after it happened.
    const state = readRestartInterruptionState(dataDir);
    expect(state?.conversations["conv-1"]?.turnClaimedAt).toBeDefined();
    expect(state?.conversations["conv-1"]?.turnCompletedAt).toBeDefined();
    expect(state?.conversations["conv-1"]?.turnFailedAt).toBeUndefined();

    // Second fire is a no-op (per-conversation claims latch it).
    const again = await fireRestartContinuationTurn(makeDeps());
    expect(again.fired).toBe(false);
  });

  it("records failure when the automation turn errors — reminder stays full guidance", async () => {
    seedState();
    const deps = makeDeps({
      runAutomationTurn: async () => ({ status: "error", error: "boom" }),
    });
    const result = await fireRestartContinuationTurn(deps);
    // The dispatch happened, but success was never claimed.
    expect(result.outcomes["conv-1"]).toBe("failed");
    const state = readRestartInterruptionState(dataDir);
    expect(state?.conversations["conv-1"]?.turnCompletedAt).toBeUndefined();
    expect(state?.conversations["conv-1"]?.turnFailedAt).toBeDefined();

    // No refire (claimed), but the reminder is the primary path with FULL
    // guidance and the work stays surfaced as resumable.
    const again = await fireRestartContinuationTurn(makeDeps());
    expect(again.fired).toBe(false);
    const attached = attach("conv-1", "run-1");
    expect(attached?.turnCompleted).toBe(false);
    const text = buildRestartReminderText({
      reason: attached!.state.reason,
      shutdownAt: attached!.state.shutdownAt,
      syntheticTurnCompleted: attached!.turnCompleted,
      threads: [
        {
          threadId: "thread-a",
          description: "Refactor the parser",
          agentType: "general",
          stateLabel: describeCurrentThreadState(
            rows.get("thread-a") ?? null,
            sentinels,
          ).label,
        },
      ],
    });
    expect(text).toContain("No automatic resume turn ran");
    expect(text).toContain("resumable via send_input");
  });

  it("records failure when the automation turn throws", async () => {
    seedState();
    const deps = makeDeps({
      runAutomationTurn: async () => {
        throw new Error("transport died");
      },
    });
    const result = await fireRestartContinuationTurn(deps);
    expect(result.outcomes["conv-1"]).toBe("failed");
    expect(
      readRestartInterruptionState(dataDir)?.conversations["conv-1"]
        ?.turnFailedAt,
    ).toBeDefined();
  });

  it("a hung early conversation never marks later conversations handled", async () => {
    writeFreshRecord();
    convert([
      { threadId: "thread-a", conversationId: "conv-1" },
      { threadId: "thread-c", conversationId: "conv-2" },
    ]);
    let releaseFirstTurn: (() => void) | undefined;
    const deps = makeDeps({
      runAutomationTurn: (args) =>
        args.conversationId === "conv-1"
          ? new Promise((resolve) => {
              releaseFirstTurn = () =>
                resolve({ status: "ok", finalText: "done" });
            })
          : Promise.resolve({ status: "ok", finalText: "done" }),
    });
    const firePromise = fireRestartContinuationTurn(deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // While conv-1 hangs: it is claimed (no refire) but NOT completed, and
    // conv-2 is untouched — its reminder is full-guidance primary recovery.
    const during = readRestartInterruptionState(dataDir);
    expect(during?.conversations["conv-1"]?.turnClaimedAt).toBeDefined();
    expect(during?.conversations["conv-1"]?.turnCompletedAt).toBeUndefined();
    expect(during?.conversations["conv-2"]).toBeUndefined();
    const conv2 = attach("conv-2", "run-9");
    expect(conv2).not.toBeNull();
    expect(conv2?.turnCompleted).toBe(false);

    releaseFirstTurn?.();
    const result = await firePromise;
    expect(result.outcomes["conv-1"]).toBe("completed");
    // conv-2 acquired a pending reminder mid-fire → the turn skips it.
    expect(result.outcomes["conv-2"]).toBe("skipped");
    const after = readRestartInterruptionState(dataDir);
    expect(after?.conversations["conv-2"]?.turnClaimedAt).toBeUndefined();
    expect(after?.conversations["conv-2"]?.reminderAttachedAt).toBeDefined();
  });

  it("does not fire on a cold boot with no interruption state", async () => {
    const deps = makeDeps();
    const result = await fireRestartContinuationTurn(deps);
    expect(result.fired).toBe(false);
    expect(deps.turns).toHaveLength(0);
    expect(deps.appended).toHaveLength(0);
  });

  it("honors the turn-only env gate while keeping the reminder available", async () => {
    seedState();
    const deps = makeDeps({
      env: { STELLA_DISABLE_RESTART_CONTINUATION_TURN: "1" },
    });
    const result = await fireRestartContinuationTurn(deps);
    expect(result.fired).toBe(false);
    expect(deps.turns).toHaveLength(0);
    // Reminder path still has the full state (primary recovery path).
    const attached = attach("conv-1", "run-1");
    expect(attached?.threads.map((t) => t.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(attached?.turnCompleted).toBe(false);
  });

  it("skips conversations whose reminder is already pending (user messaged first)", async () => {
    seedState();
    expect(attach("conv-1", "run-1")).not.toBeNull();
    const deps = makeDeps();
    const result = await fireRestartContinuationTurn(deps);
    expect(result.fired).toBe(false);
    expect(result.outcomes["conv-1"]).toBe("skipped");
    expect(deps.turns).toHaveLength(0);
  });
});

describe("delivery-safe reminder consumption", () => {
  const seed = (reason = "app-shutdown") => {
    writeFreshRecord(reason);
    convert([{ threadId: "thread-a", conversationId: "conv-1" }]);
  };

  it("consumes only after the carrying turn succeeds, then stays consumed", () => {
    seed();
    expect(attach("conv-1", "run-1")).not.toBeNull();
    // Still pending — a re-attach before resolution is allowed.
    expect(attach("conv-1", "run-1")).not.toBeNull();
    resolveRestartReminderOutcome(dataDir, {
      conversationId: "conv-1",
      runId: "run-1",
      succeeded: true,
    });
    expect(attach("conv-1", "run-2")).toBeNull();
    // Single conversation drained → state file removed.
    expect(fs.existsSync(stateFilePath())).toBe(false);
  });

  it("re-attaches when the carrying turn fails or is interrupted", () => {
    seed();
    expect(attach("conv-1", "run-1")).not.toBeNull();
    resolveRestartReminderOutcome(dataDir, {
      conversationId: "conv-1",
      runId: "run-1",
      succeeded: false,
    });
    // Pending mark cleared → next user message re-attaches, still full.
    const state = readRestartInterruptionState(dataDir);
    expect(state?.conversations["conv-1"]?.reminderAttachedAt).toBeUndefined();
    expect(state?.conversations["conv-1"]?.reminderConsumedAt).toBeUndefined();
    const again = attach("conv-1", "run-2");
    expect(again).not.toBeNull();
    expect(again?.turnCompleted).toBe(false);
  });

  it("ignores outcomes from runs that are not carrying the reminder", () => {
    seed();
    expect(attach("conv-1", "run-1")).not.toBeNull();
    resolveRestartReminderOutcome(dataDir, {
      conversationId: "conv-1",
      runId: "other-run",
      succeeded: true,
    });
    expect(
      readRestartInterruptionState(dataDir)?.conversations["conv-1"]
        ?.reminderConsumedAt,
    ).toBeUndefined();
  });

  it("only fires for conversations that actually had interrupted work", () => {
    seed();
    expect(attach("conv-2", "run-1")).toBeNull();
    expect(attach("conv-1", "run-1")).not.toBeNull();
  });
});

describe("current-state labels and reminder text", () => {
  it("labels paused, restart-canceled, and completed threads distinctly", () => {
    expect(
      describeCurrentThreadState(
        makeRecordRow({ threadId: "t", error: AGENT_PAUSE_CANCEL_REASON }),
        sentinels,
      ),
    ).toMatchObject({ paused: true, resumable: false });
    expect(
      describeCurrentThreadState(makeRecordRow({ threadId: "t" }), sentinels),
    ).toMatchObject({
      resumable: true,
      label: "canceled by the restart — resumable via send_input",
    });
    expect(
      describeCurrentThreadState(
        makeRecordRow({
          threadId: "t",
          status: "completed",
          error: undefined,
          result: "Done",
        }),
        sentinels,
      ).label,
    ).toContain("completed");
    expect(describeCurrentThreadState(null, sentinels).label).toBe(
      "no longer tracked",
    );
  });

  it("switches between full guidance and brief confirmation", () => {
    const base = {
      reason: "app-shutdown",
      shutdownAt: Date.now(),
      threads: [
        {
          threadId: "thread-a",
          description: "Refactor the parser",
          agentType: "general",
          stateLabel: "canceled by the restart — resumable via send_input",
        },
      ],
    };
    const full = buildRestartReminderText({
      ...base,
      syntheticTurnCompleted: false,
    });
    expect(full).toContain("app-shutdown");
    expect(full).toContain("thread-a");
    expect(full).toContain("No automatic resume turn ran");
    const brief = buildRestartReminderText({
      ...base,
      syntheticTurnCompleted: true,
    });
    expect(brief).toContain("already ran");
    expect(brief).not.toContain("No automatic resume turn ran");
  });
});

describe("LocalAgentManager boot snapshot", () => {
  it("captures threads that were running at shutdown before the orphan sweep flips them", () => {
    const saved: PersistedAgentRecord[] = [];
    const running: PersistedAgentRecord[] = [
      {
        threadId: "thread-a",
        conversationId: "conv-1",
        agentType: "general",
        description: "Refactor the parser",
        agentDepth: 1,
        status: "running",
        attemptGeneration: 0,
        startedAt: Date.now(),
        completedAt: null,
        updatedAt: Date.now(),
      },
      {
        threadId: "thread-b",
        conversationId: "conv-1",
        agentType: "general",
        description: "Coordinate the release",
        agentDepth: 2,
        parentAgentId: "thread-a",
        status: "running",
        attemptGeneration: 0,
        startedAt: Date.now(),
        completedAt: null,
        updatedAt: Date.now(),
      },
    ];
    let rowsFlippedWhenSnapshotPersisted = -1;
    let snapshotThreads: Array<{ threadId: string; conversationId: string }> =
      [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      listAgentRecordsByStatus: (status: string) =>
        status === "running" ? running : [],
      saveAgentRecord: (record: PersistedAgentRecord) => {
        saved.push(record);
      },
      hasAgentLifecycleEvent: () => true,
      persistBootInterruptionSnapshot: (
        threads: Array<{ threadId: string; conversationId: string }>,
      ) => {
        rowsFlippedWhenSnapshotPersisted = saved.length;
        snapshotThreads = threads;
        return "episode-test";
      },
    } as unknown as ConstructorParameters<typeof LocalAgentManager>[0]);

    expect(manager.getBootInterruptedThreads()).toEqual([
      { threadId: "thread-a", conversationId: "conv-1" },
      { threadId: "thread-b", conversationId: "conv-1" },
    ]);
    // The durable snapshot is persisted BEFORE any row is flipped — it is
    // the retry evidence that survives the flip.
    expect(rowsFlippedWhenSnapshotPersisted).toBe(0);
    expect(snapshotThreads).toEqual(manager.getBootInterruptedThreads());
    // The capture holds the episode id it was authorized under.
    expect(manager.getBootInterruptionEpisodeId()).toBe("episode-test");
    // Existing sweep behavior is preserved: every running row — root or
    // subagent — is orphan-canceled with the restart reason.
    const root = saved.find((r) => r.threadId === "thread-a");
    expect(root?.status).toBe("canceled");
    expect(root?.error).toBe(AGENT_ORPHANED_RESTART_CANCEL_REASON);
    const child = saved.find((r) => r.threadId === "thread-b");
    expect(child?.status).toBe("canceled");
    expect(child?.error).toBe(AGENT_ORPHANED_RESTART_CANCEL_REASON);
  });
});

describe("restart-continuation reminder hooks", () => {
  const makeHooks = (rows: Map<string, PersistedAgentRecord>) =>
    createRestartContinuationReminderHooks({
      stellaDataDir: dataDir,
      store: {
        getAgentRecord: (threadId: string) => rows.get(threadId) ?? null,
      } as unknown as Parameters<
        typeof createRestartContinuationReminderHooks
      >[0]["store"],
    });

  const persistedRow = (
    overrides: Partial<PersistedAgentRecord> & { threadId: string },
  ): PersistedAgentRecord => ({
    conversationId: "conv-1",
    agentType: "general",
    description: "Refactor the parser",
    agentDepth: 1,
    status: "canceled",
    error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
    attemptGeneration: 0,
    startedAt: Date.now(),
    completedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const seed = (reason = "app-shutdown") => {
    writeFreshRecord(reason);
    convert([{ threadId: "thread-a", conversationId: "conv-1" }]);
  };

  const userPayload = (runId: string) =>
    ({
      agentType: "orchestrator",
      userPrompt: "hey, how is it going?",
      conversationId: "conv-1",
      isUserTurn: true,
      runId,
    }) as never;

  it("attaches a hidden reminder and consumes it only after the carrying turn succeeds", async () => {
    seed();
    const [attachHook, settleHook] = makeHooks(
      new Map([["thread-a", persistedRow({ threadId: "thread-a" })]]),
    );
    const result = await attachHook.handler(userPayload("run-1"));
    expect(result?.prependMessages).toHaveLength(1);
    const message = result!.prependMessages![0];
    expect(message.uiVisibility).toBe("hidden");
    expect(message.text).toContain("<system-reminder>");
    expect(message.text).toContain("thread-a");
    expect(message.text).toContain(
      "canceled by the restart — resumable via send_input",
    );
    expect(message.text).toContain("app-shutdown");

    // Carrying turn FAILS → not consumed; re-attaches on the next message.
    await settleHook.handler({
      agentType: "orchestrator",
      conversationId: "conv-1",
      runId: "run-1",
      isUserTurn: true,
      finalText: "boom",
      outcome: "error",
    } as never);
    const retry = await attachHook.handler(userPayload("run-2"));
    expect(retry?.prependMessages).toHaveLength(1);

    // Carrying turn SUCCEEDS → consumed; no further attachments.
    await settleHook.handler({
      agentType: "orchestrator",
      conversationId: "conv-1",
      runId: "run-2",
      isUserTurn: true,
      finalText: "ok",
      outcome: "success",
    } as never);
    expect(await attachHook.handler(userPayload("run-3"))).toBeUndefined();
  });

  it("never attaches or settles on hidden/system turns (including the synthetic turn)", async () => {
    seed();
    const [attachHook, settleHook] = makeHooks(
      new Map([["thread-a", persistedRow({ threadId: "thread-a" })]]),
    );
    const hidden = await attachHook.handler({
      agentType: "orchestrator",
      userPrompt: "[Stella runtime] …",
      conversationId: "conv-1",
      isUserTurn: false,
      runId: "auto-run",
    } as never);
    expect(hidden).toBeUndefined();
    // A hidden turn's success must not consume an unattached reminder.
    await settleHook.handler({
      agentType: "orchestrator",
      conversationId: "conv-1",
      runId: "auto-run",
      isUserTurn: false,
      finalText: "ok",
      outcome: "success",
    } as never);
    // Still available for the real user turn.
    const real = await attachHook.handler(userPayload("run-1"));
    expect(real?.prependMessages).toHaveLength(1);
  });

  it("stays silent on clean-idle shutdowns and untouched conversations", async () => {
    // Record written, but nothing was running → no state at all.
    writeFreshRecord();
    convert([]);
    const [attachHook] = makeHooks(new Map());
    expect(await attachHook.handler(userPayload("run-1"))).toBeUndefined();
  });

  it("goes brief only when the synthetic turn actually completed", async () => {
    seed("self-mod-apply-process-restart");
    const rows = new Map([
      ["thread-a", persistedRow({ threadId: "thread-a" })],
    ]);
    const fired = await fireRestartContinuationTurn({
      stellaDataDir: dataDir,
      env: {},
      sentinels,
      getAgentRecord: (threadId) => rows.get(threadId) ?? null,
      listAgentRecordsByStatus: () => [],
      appendLocalChatEvent: vi.fn(),
      runAutomationTurn: async () => ({ status: "ok", finalText: "done" }),
    });
    expect(fired.outcomes["conv-1"]).toBe("completed");

    const [attachHook] = makeHooks(rows);
    const result = await attachHook.handler(userPayload("run-1"));
    expect(result?.prependMessages).toHaveLength(1);
    expect(result!.prependMessages![0].text).toContain("already ran");
    expect(result!.prependMessages![0].text).not.toContain(
      "No automatic resume turn ran",
    );
  });

  it("stays full guidance when the synthetic turn failed", async () => {
    seed();
    const rows = new Map([
      ["thread-a", persistedRow({ threadId: "thread-a" })],
    ]);
    const fired = await fireRestartContinuationTurn({
      stellaDataDir: dataDir,
      env: {},
      sentinels,
      getAgentRecord: (threadId) => rows.get(threadId) ?? null,
      listAgentRecordsByStatus: () => [],
      appendLocalChatEvent: vi.fn(),
      runAutomationTurn: async () => ({ status: "error", error: "boom" }),
    });
    expect(fired.outcomes["conv-1"]).toBe("failed");

    const [attachHook] = makeHooks(rows);
    const result = await attachHook.handler(userPayload("run-1"));
    expect(result?.prependMessages).toHaveLength(1);
    expect(result!.prependMessages![0].text).toContain(
      "No automatic resume turn ran",
    );
  });
});
