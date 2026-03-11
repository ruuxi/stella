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
      isHostAuthAuthenticated: () => true,
      frontendRoot: "C:/Users/redacted/projects/stella/desktop",
      assertPrivilegedSender: () => true,
      hmrMorphOrchestrator: null,
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
});
