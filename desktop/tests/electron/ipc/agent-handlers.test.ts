import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcOnHandlers = new Map<string, (...args: unknown[]) => void>();
const receiverById = new Map<number, { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }>();
const fromId = vi.fn((id: number) => receiverById.get(id) ?? null);

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcOnHandlers.set(channel, handler);
    }),
  },
  webContents: {
    fromId,
  },
}));

const { registerAgentHandlers } = await import("../../../electron/ipc/agent-handlers.js");

const createSenderEvent = (id: number) => ({
  sender: { id },
});

describe("registerAgentHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
    ipcOnHandlers.clear();
    receiverById.clear();
    fromId.mockClear();
  });

  it("buffers early task lifecycle events under the new run instead of a stale prior run", async () => {
    const senderId = 17;
    const send = vi.fn();
    receiverById.set(senderId, {
      isDestroyed: () => false,
      send,
    });

    const handleLocalChat = vi.fn()
      .mockResolvedValueOnce({ runId: "run-old" })
      .mockImplementationOnce(async (_payload, callbacks) => {
        callbacks.onTaskEvent?.({
          type: "task-started",
          conversationId: "conv-1",
          rootRunId: "run-new",
          taskId: "task-1",
          agentType: "general",
          description: "Investigate the file",
        });

        return { runId: "run-new" };
      });

    registerAgentHandlers({
      getStellaHostRunner: () => ({
        agentHealthCheck: () => ({ ready: true }),
        handleLocalChat,
        cancelLocalChat: vi.fn(),
        getActiveOrchestratorRun: () => null,
      }) as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      frontendRoot: "/mock/project/stella/desktop",
      assertPrivilegedSender: () => true,
      hmrTransitionController: null,
    });

    const startChat = ipcHandleHandlers.get("agent:startChat");
    const resume = ipcHandleHandlers.get("agent:resume");

    expect(startChat).toBeTypeOf("function");
    expect(resume).toBeTypeOf("function");

    await startChat?.(createSenderEvent(senderId), {
      conversationId: "conv-1",
      userMessageId: "msg-old",
      userPrompt: "First request",
    });

    const secondStartResult = await startChat?.(createSenderEvent(senderId), {
      conversationId: "conv-1",
      userMessageId: "msg-new",
      userPrompt: "Second request",
    });

    const newRunReplay = await resume?.({}, { runId: "run-new", lastSeq: 0 }) as {
      events: Array<Record<string, unknown>>;
      exhausted: boolean;
    };
    const oldRunReplay = await resume?.({}, { runId: "run-old", lastSeq: 0 }) as {
      events: Array<Record<string, unknown>>;
      exhausted: boolean;
    };

    expect(secondStartResult).toEqual({ runId: "run-new" });
    expect(send).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({
        type: "task-started",
        runId: "run-new",
        taskId: "task-1",
      }),
    );
    expect(newRunReplay.events).toEqual([
      expect.objectContaining({
        type: "task-started",
        runId: "run-new",
        taskId: "task-1",
        agentType: "general",
        description: "Investigate the file",
      }),
    ]);
    expect(oldRunReplay.events).toEqual([]);
  });

  it("assigns unique increasing seq values to task events emitted in the same millisecond", async () => {
    const senderId = 19;
    const send = vi.fn();
    receiverById.set(senderId, {
      isDestroyed: () => false,
      send,
    });

    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);

    try {
      registerAgentHandlers({
        getStellaHostRunner: () => ({
          agentHealthCheck: () => ({ ready: true }),
          handleLocalChat: vi.fn(async (_payload, callbacks) => {
            callbacks.onTaskEvent?.({
              type: "task-started",
              conversationId: "conv-1",
              rootRunId: "run-seq",
              taskId: "task-1",
              agentType: "general",
              description: "Investigate the file",
            });
            callbacks.onTaskEvent?.({
              type: "task-completed",
              conversationId: "conv-1",
              rootRunId: "run-seq",
              taskId: "task-1",
              agentType: "general",
              result: "Done",
            });

            return { runId: "run-seq" };
          }),
          cancelLocalChat: vi.fn(),
          getActiveOrchestratorRun: () => null,
        }) as never,
        getAppSessionStartedAt: () => 0,
        isHostAuthAuthenticated: () => true,
        frontendRoot: "/mock/project/stella/desktop",
        assertPrivilegedSender: () => true,
        hmrTransitionController: null,
      });

      const startChat = ipcHandleHandlers.get("agent:startChat");
      const resume = ipcHandleHandlers.get("agent:resume");

      expect(startChat).toBeTypeOf("function");
      expect(resume).toBeTypeOf("function");

      await startChat?.(createSenderEvent(senderId), {
        conversationId: "conv-1",
        userMessageId: "msg-1",
        userPrompt: "Check this",
      });

      const replay = await resume?.({}, { runId: "run-seq", lastSeq: 0 }) as {
        events: Array<Record<string, unknown>>;
        exhausted: boolean;
      };

      expect(replay.events).toHaveLength(2);
      expect(replay.events[0]).toEqual(
        expect.objectContaining({
          type: "task-started",
          seq: 10_000,
        }),
      );
      expect(replay.events[1]).toEqual(
        expect.objectContaining({
          type: "task-completed",
          seq: 10_001,
        }),
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns the app session start timestamp", async () => {
    registerAgentHandlers({
      getStellaHostRunner: () => null,
      getAppSessionStartedAt: () => 1234,
      isHostAuthAuthenticated: () => true,
      frontendRoot: "/mock/project/stella/desktop",
      assertPrivilegedSender: () => true,
      hmrTransitionController: null,
    });

    const getAppSessionStartedAt = ipcHandleHandlers.get("agent:getAppSessionStartedAt");

    expect(getAppSessionStartedAt).toBeTypeOf("function");
    await expect(getAppSessionStartedAt?.()).resolves.toBe(1234);
  });

  it("awaits fresh runtime health and active-run reads for resume checks", async () => {
    const getActiveOrchestratorRun = vi.fn(async () => ({
      runId: "run-active",
      conversationId: "conv-1",
    }));

    registerAgentHandlers({
      getStellaHostRunner: () => ({
        agentHealthCheck: vi.fn(async () => ({ ready: true })),
        handleLocalChat: vi.fn(),
        cancelLocalChat: vi.fn(),
        getActiveOrchestratorRun,
      }) as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      frontendRoot: "/mock/project/stella/desktop",
      assertPrivilegedSender: () => true,
      hmrTransitionController: null,
    });

    const healthCheck = ipcHandleHandlers.get("agent:healthCheck");
    const getActiveRun = ipcHandleHandlers.get("agent:getActiveRun");

    await expect(healthCheck?.()).resolves.toEqual({ ready: true });
    await expect(getActiveRun?.()).resolves.toEqual({
      runId: "run-active",
      conversationId: "conv-1",
    });
    expect(getActiveOrchestratorRun).toHaveBeenCalledTimes(1);
  });

  it("routes dashboard generation and self-mod utilities through the sidecar runner", async () => {
    const startPersonalWebsiteGeneration = vi.fn(async () => undefined);
    const revertSelfModFeature = vi.fn(async () => ({
      featureId: "feature-1",
      revertedCommitHashes: ["abc123"],
      message: "Reverted 1 commit for feature feature-1.",
    }));
    const getLastSelfModFeature = vi.fn(async () => "feature-1");
    const listRecentSelfModFeatures = vi.fn(async () => [
      {
        featureId: "feature-1",
        name: "Feature 1",
        description: "",
        latestCommit: "abc123",
        latestTimestampMs: 1,
        commitCount: 1,
      },
    ]);

    registerAgentHandlers({
      getStellaHostRunner: () =>
        ({
          agentHealthCheck: vi.fn(async () => ({ ready: true })),
          handleLocalChat: vi.fn(),
          cancelLocalChat: vi.fn(),
          getActiveOrchestratorRun: vi.fn(async () => null),
          startPersonalWebsiteGeneration,
          revertSelfModFeature,
          getLastSelfModFeature,
          listRecentSelfModFeatures,
        }) as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      frontendRoot: "/mock/project/stella/desktop",
      assertPrivilegedSender: () => true,
      hmrTransitionController: null,
    });

    const generateHandler = ipcHandleHandlers.get("agent:startPersonalWebsiteGeneration");
    const revertHandler = ipcHandleHandlers.get("selfmod:revert");
    const lastFeatureHandler = ipcHandleHandlers.get("selfmod:lastFeature");
    const recentFeaturesHandler = ipcHandleHandlers.get("selfmod:recentFeatures");

    await expect(
      generateHandler?.(createSenderEvent(1), {
        conversationId: "conv-1",
        coreMemory: "core",
        promptConfig: {
          systemPrompt: "system",
          userPromptTemplate: "user",
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      revertHandler?.(createSenderEvent(1), {
        featureId: "feature-1",
        steps: 2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        featureId: "feature-1",
        revertedCommitHashes: ["abc123"],
      }),
    );
    await expect(lastFeatureHandler?.(createSenderEvent(1))).resolves.toBe("feature-1");
    await expect(
      recentFeaturesHandler?.(createSenderEvent(1), { limit: 4 }),
    ).resolves.toEqual([
      expect.objectContaining({
        featureId: "feature-1",
      }),
    ]);

    expect(startPersonalWebsiteGeneration).toHaveBeenCalledWith({
      conversationId: "conv-1",
      coreMemory: "core",
      promptConfig: {
        systemPrompt: "system",
        userPromptTemplate: "user",
      },
    });
    expect(revertSelfModFeature).toHaveBeenCalledWith({
      featureId: "feature-1",
      steps: 2,
    });
    expect(getLastSelfModFeature).toHaveBeenCalledTimes(1);
    expect(listRecentSelfModFeatures).toHaveBeenCalledWith(4);
  });
});
