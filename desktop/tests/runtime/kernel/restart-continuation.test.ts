import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RESTART_CONTINUATION_MAX_RECORD_AGE_MS,
  RESTART_CONTINUATION_RECORD_FILE,
  RESTART_INTERRUPTION_STATE_FILE,
  buildRestartReminderText,
  consumeRestartReminderForConversation,
  consumeRestartShutdownRecord,
  convertRestartShutdownRecordAtBoot,
  describeCurrentThreadState,
  fireRestartContinuationTurn,
  isRestartContinuationEnabled,
  isRestartContinuationTurnEnabled,
  readRestartInterruptionState,
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
import { createRestartContinuationReminderHook } from "../../../../runtime/extensions/stella-runtime/hooks/restart-continuation-reminder.hook.js";

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

const writeFreshRecord = (reason = "self-mod-apply-process-restart") => {
  expect(writeRestartShutdownRecord(dataDir, { reason })).toBe(true);
};

const convert = (
  interruptedThreads: Array<{ threadId: string; conversationId: string }>,
  options?: { env?: Record<string, string | undefined>; now?: number },
) =>
  convertRestartShutdownRecordAtBoot({
    stellaDataDir: dataDir,
    env: options?.env ?? {},
    interruptedThreads,
    ...(options?.now !== undefined ? { now: options.now } : {}),
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
  it("writes on restart initiation and is consumed exactly once", () => {
    writeFreshRecord("runtime-reload");
    expect(
      fs.existsSync(path.join(dataDir, RESTART_CONTINUATION_RECORD_FILE)),
    ).toBe(true);

    const first = consumeRestartShutdownRecord(dataDir);
    expect(first?.reason).toBe("runtime-reload");
    expect(consumeRestartShutdownRecord(dataDir)).toBeNull();
    expect(
      fs.existsSync(path.join(dataDir, RESTART_CONTINUATION_RECORD_FILE)),
    ).toBe(false);
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
    // Record consumed: a second boot converts nothing (no double fire).
    expect(convert(threads)).toBeNull();
  });

  it("ignores stale records and produces no state (no turn, no reminder)", () => {
    writeFreshRecord();
    const state = convert(threads, {
      now: Date.now() + RESTART_CONTINUATION_MAX_RECORD_AGE_MS + 1,
    });
    expect(state).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
    expect(
      consumeRestartReminderForConversation(dataDir, "conv-1"),
    ).toBeNull();
  });

  it("produces nothing when the shutdown was idle (no running threads)", () => {
    writeFreshRecord();
    expect(convert([])).toBeNull();
    expect(readRestartInterruptionState(dataDir)).toBeNull();
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
    expect(
      fs.existsSync(path.join(dataDir, RESTART_CONTINUATION_RECORD_FILE)),
    ).toBe(false);
  });
});

describe("boot-time continuation turn", () => {
  const rows = new Map<string, RestartThreadRecordLike>([
    ["thread-a", makeRecordRow({ threadId: "thread-a" })],
    [
      "thread-mgr",
      makeRecordRow({
        threadId: "thread-mgr",
        agentType: "manager",
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
  ]);

  const makeDeps = (
    overrides?: Partial<RestartContinuationFireDeps>,
  ): RestartContinuationFireDeps & {
    appended: Array<{ conversationId: string; payload: Record<string, unknown> }>;
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
      { threadId: "thread-mgr", conversationId: "conv-1" },
    ]);
    expect(state).not.toBeNull();
  };

  it("fires exactly once with facts, paused-thread mentions, and chat notices", async () => {
    seedState();
    const deps = makeDeps();
    const result = await fireRestartContinuationTurn(deps);
    expect(result.fired).toBe(true);
    expect(result.conversationIds).toEqual(["conv-1"]);

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
    expect(prompt).toContain("thread-mgr");
    expect(prompt).toContain("completed");
    // User-paused thread is mentioned but excluded from the resume list.
    expect(prompt).toContain("thread-paused");
    expect(prompt).toContain("do NOT resume");

    // Second fire is a no-op (state latched).
    const again = await fireRestartContinuationTurn(makeDeps());
    expect(again.fired).toBe(false);
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
    const consumed = consumeRestartReminderForConversation(dataDir, "conv-1");
    expect(consumed?.threads.map((t) => t.threadId)).toEqual([
      "thread-a",
      "thread-mgr",
    ]);
    expect(consumed?.state.syntheticTurnFiredAt).toBeUndefined();
  });

  it("skips conversations whose reminder already attached (user messaged first)", async () => {
    seedState();
    expect(
      consumeRestartReminderForConversation(dataDir, "conv-1"),
    ).not.toBeNull();
    const deps = makeDeps();
    const result = await fireRestartContinuationTurn(deps);
    expect(result.fired).toBe(false);
    expect(deps.turns).toHaveLength(0);
  });
});

describe("next-user-message reminder consumption", () => {
  it("is one-shot per conversation and deletes the state when drained", () => {
    writeFreshRecord("app-shutdown");
    convert([{ threadId: "thread-a", conversationId: "conv-1" }]);

    const first = consumeRestartReminderForConversation(dataDir, "conv-1");
    expect(first?.threads).toHaveLength(1);
    expect(consumeRestartReminderForConversation(dataDir, "conv-1")).toBeNull();
    expect(
      fs.existsSync(path.join(dataDir, RESTART_INTERRUPTION_STATE_FILE)),
    ).toBe(false);
  });

  it("only fires for conversations that actually had interrupted work", () => {
    writeFreshRecord();
    convert([{ threadId: "thread-a", conversationId: "conv-1" }]);
    expect(consumeRestartReminderForConversation(dataDir, "conv-2")).toBeNull();
    // conv-1 still pending afterwards.
    expect(
      consumeRestartReminderForConversation(dataDir, "conv-1"),
    ).not.toBeNull();
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
      syntheticTurnFired: false,
    });
    expect(full).toContain("app-shutdown");
    expect(full).toContain("thread-a");
    expect(full).toContain("No automatic resume turn ran");
    const brief = buildRestartReminderText({
      ...base,
      syntheticTurnFired: true,
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
        threadId: "thread-mgr",
        conversationId: "conv-1",
        agentType: "manager",
        description: "Coordinate the release",
        agentDepth: 1,
        status: "running",
        attemptGeneration: 0,
        startedAt: Date.now(),
        completedAt: null,
        updatedAt: Date.now(),
      },
    ];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      listAgentRecordsByStatus: (status: string) =>
        status === "running" ? running : [],
      saveAgentRecord: (record: PersistedAgentRecord) => {
        saved.push(record);
      },
      hasAgentLifecycleEvent: () => true,
    } as unknown as ConstructorParameters<typeof LocalAgentManager>[0]);

    expect(manager.getBootInterruptedThreads()).toEqual([
      { threadId: "thread-a", conversationId: "conv-1" },
      { threadId: "thread-mgr", conversationId: "conv-1" },
    ]);
    // Existing sweep behavior is preserved: general → orphan-canceled,
    // manager → completed with a synthesized report.
    const general = saved.find((r) => r.threadId === "thread-a");
    expect(general?.status).toBe("canceled");
    expect(general?.error).toBe(AGENT_ORPHANED_RESTART_CANCEL_REASON);
    const managerRow = saved.find((r) => r.threadId === "thread-mgr");
    expect(managerRow?.status).toBe("completed");
  });
});

describe("restart-continuation reminder hook", () => {
  const makeHook = (rows: Map<string, PersistedAgentRecord>) =>
    createRestartContinuationReminderHook({
      stellaDataDir: dataDir,
      store: {
        getAgentRecord: (threadId: string) => rows.get(threadId) ?? null,
      } as unknown as Parameters<
        typeof createRestartContinuationReminderHook
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

  it("attaches a hidden reminder exactly once on the first post-boot user turn", async () => {
    seed();
    const hook = makeHook(
      new Map([["thread-a", persistedRow({ threadId: "thread-a" })]]),
    );
    const payload = {
      agentType: "orchestrator",
      userPrompt: "hey, how is it going?",
      conversationId: "conv-1",
      isUserTurn: true,
    };
    const result = await hook.handler(payload as never);
    expect(result?.prependMessages).toHaveLength(1);
    const message = result!.prependMessages![0];
    expect(message.uiVisibility).toBe("hidden");
    expect(message.text).toContain("<system-reminder>");
    expect(message.text).toContain("thread-a");
    expect(message.text).toContain(
      "canceled by the restart — resumable via send_input",
    );
    expect(message.text).toContain("app-shutdown");

    // One-shot: the next user turn gets nothing.
    expect(await hook.handler(payload as never)).toBeUndefined();
  });

  it("never consumes on hidden/system turns (including the synthetic turn)", async () => {
    seed();
    const hook = makeHook(
      new Map([["thread-a", persistedRow({ threadId: "thread-a" })]]),
    );
    const hidden = await hook.handler({
      agentType: "orchestrator",
      userPrompt: "[Stella runtime] …",
      conversationId: "conv-1",
      isUserTurn: false,
    } as never);
    expect(hidden).toBeUndefined();
    // Still available for the real user turn.
    const real = await hook.handler({
      agentType: "orchestrator",
      userPrompt: "hello",
      conversationId: "conv-1",
      isUserTurn: true,
    } as never);
    expect(real?.prependMessages).toHaveLength(1);
  });

  it("stays silent on clean-idle shutdowns and untouched conversations", async () => {
    // Record written, but nothing was running → no state at all.
    writeFreshRecord();
    convert([]);
    const hook = makeHook(new Map());
    expect(
      await hook.handler({
        agentType: "orchestrator",
        userPrompt: "hello",
        conversationId: "conv-1",
        isUserTurn: true,
      } as never),
    ).toBeUndefined();
  });

  it("goes brief when the synthetic turn already fired", async () => {
    seed("self-mod-apply-process-restart");
    const rows = new Map([["thread-a", persistedRow({ threadId: "thread-a" })]]);
    const fired = await fireRestartContinuationTurn({
      stellaDataDir: dataDir,
      env: {},
      sentinels,
      getAgentRecord: (threadId) => rows.get(threadId) ?? null,
      listAgentRecordsByStatus: () => [],
      appendLocalChatEvent: vi.fn(),
      runAutomationTurn: async () => ({ status: "ok", finalText: "done" }),
    });
    expect(fired.fired).toBe(true);

    const hook = makeHook(rows);
    const result = await hook.handler({
      agentType: "orchestrator",
      userPrompt: "hello",
      conversationId: "conv-1",
      isUserTurn: true,
    } as never);
    expect(result?.prependMessages).toHaveLength(1);
    expect(result!.prependMessages![0].text).toContain("already ran");
    expect(result!.prependMessages![0].text).not.toContain(
      "No automatic resume turn ran",
    );
  });
});
