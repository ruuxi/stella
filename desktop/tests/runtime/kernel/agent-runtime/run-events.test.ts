import { describe, expect, it, vi } from "vitest";
import { AssistantMessageEventStream } from "../../../../../runtime/ai/utils/event-stream.js";
import type { AssistantMessage } from "../../../../../runtime/ai/types.js";
import { runAgentLoop } from "../../../../../runtime/kernel/agent-core/agent-loop.js";
import type { AgentEvent } from "../../../../../runtime/kernel/agent-core/types.js";
import { createPiTools } from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
import type {
  RuntimeStatusEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "../../../../../runtime/kernel/agent-runtime/types.js";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "../../../../../runtime/kernel/agent-runtime/run-events.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  initialStoreState,
  streamStoreReducer,
} from "@/features/chat/streaming/store";
import {
  getInlineWorkingIndicatorActive,
  getWorkingIndicatorDisplayStatus,
} from "@/features/chat/working-indicator-state";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const assistantMessage = {
  role: "assistant" as const,
  content: [
    {
      type: "thinking" as const,
      thinking: "Need to inspect the task.",
      thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
    },
    { type: "text" as const, text: "" },
  ],
  api: "openai-responses" as const,
  provider: "openai",
  model: "gpt-5.4",
  usage,
  stopReason: "stop" as const,
  timestamp: 1,
};

const createToolCallMessage = (toolName: string): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: `call-${toolName}`,
      name: toolName,
      arguments: {},
    },
  ],
  api: "openai-completions",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "toolUse",
  timestamp: 1,
});

const createTextMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

const streamMessage = (message: AssistantMessage): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "start",
      partial: message,
    });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  });
  return stream;
};

const runToolStatusIntegration = async (toolName: string) => {
  const runId = `run-${toolName}`;
  const conversationId = `conversation-${toolName}`;
  const userMessageId = `user-${toolName}`;
  const listeners = new Set<(event: AgentEvent) => void>();
  const agent = {
    state: { messages: [] },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const recordedRunEvents: unknown[] = [];
  const statusEvents: RuntimeStatusEvent[] = [];
  const toolStartEvents: RuntimeToolStartEvent[] = [];
  const toolEndEvents: RuntimeToolEndEvent[] = [];
  const store = {
    recordRunEvent: (event: unknown) => {
      recordedRunEvents.push(event);
    },
  };

  subscribeRuntimeAgentEvents({
    agent,
    runId,
    agentType: AGENT_IDS.ORCHESTRATOR,
    recorder: createRunEventRecorder({
      store: store as never,
      runId,
      conversationId,
      agentType: AGENT_IDS.ORCHESTRATOR,
      userMessageId,
    }),
    callbacks: {
      onStatus: (event) => {
        statusEvents.push(event);
      },
      onToolStart: (event) => {
        toolStartEvents.push(event);
      },
      onToolEnd: (event) => {
        toolEndEvents.push(event);
      },
    },
  });

  const tools = createPiTools({
    runId,
    conversationId,
    agentType: AGENT_IDS.ORCHESTRATOR,
    deviceId: "device-1",
    toolsAllowlist: [toolName],
    toolCatalog: [
      {
        name: toolName,
        description: `${toolName} tool`,
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ],
    store: store as never,
    toolExecutor: async () => ({
      result: "ok",
    }),
  });

  let callCount = 0;
  await runAgentLoop(
    [{ role: "user", content: "Use the tool.", timestamp: 1 }],
    {
      systemPrompt: "Use the requested tool, then answer.",
      messages: [],
      tools,
    },
    {
      model: {
        provider: "openai",
        id: "test-model",
        contextWindow: 128_000,
      },
      convertToLlm: async (messages) => messages as never,
      toolExecution: "sequential",
    } as never,
    async (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    undefined,
    async () => {
      callCount += 1;
      return streamMessage(
        callCount === 1
          ? createToolCallMessage(toolName)
          : createTextMessage("Done."),
      );
    },
  );

  const statusEvent = statusEvents[0];
  if (!statusEvent) {
    throw new Error(`Expected ${toolName} to emit a status event`);
  }

  let state = streamStoreReducer(initialStoreState, {
    type: "run-started",
    runId,
    conversationId,
    userMessageId,
  });
  const activeBeforeTool = getInlineWorkingIndicatorActive({
    isStreaming: true,
    isStreamingResponseText: false,
    isToolActive: Boolean(
      Object.keys(state.runsById[runId]?.activeToolCalls ?? {}).length,
    ),
    hasRunningTask: Object.values(state.tasksByRunId[runId] ?? {}).some(
      (task) => task.status === "running",
    ),
  });
  state = streamStoreReducer(state, {
    type: "run-status",
    runId,
    statusText: statusEvent.statusText,
  });
  const toolStartEvent = toolStartEvents[0];
  if (!toolStartEvent) {
    throw new Error(`Expected ${toolName} to emit a tool start event`);
  }
  state = streamStoreReducer(state, {
    type: "tool-start",
    runId,
    conversationId,
    ...(toolStartEvent.toolCallId
      ? { toolCallId: toolStartEvent.toolCallId }
      : {}),
    ...(toolStartEvent.toolName ? { toolName: toolStartEvent.toolName } : {}),
    statusText: toolStartEvent.statusText ?? null,
  });
  const toolActiveRun = state.runsById[runId];
  const activeDuringTool = getInlineWorkingIndicatorActive({
    isStreaming: true,
    isStreamingResponseText: false,
    isToolActive: Boolean(
      Object.keys(toolActiveRun?.activeToolCalls ?? {}).length,
    ),
    hasRunningTask: Object.values(state.tasksByRunId[runId] ?? {}).some(
      (task) => task.status === "running",
    ),
  });
  const displayStatusDuringTool = getWorkingIndicatorDisplayStatus({
    status: toolActiveRun?.statusText ?? undefined,
    toolName: toolStartEvent.toolName,
    toolCallId: toolStartEvent.toolCallId,
  });
  const toolEndEvent = toolEndEvents[0];
  if (!toolEndEvent) {
    throw new Error(`Expected ${toolName} to emit a tool end event`);
  }
  state = streamStoreReducer(state, {
    type: "tool-end",
    runId,
    ...(toolEndEvent.toolCallId ? { toolCallId: toolEndEvent.toolCallId } : {}),
    ...(toolEndEvent.toolName ? { toolName: toolEndEvent.toolName } : {}),
  });
  const toolEndedRun = state.runsById[runId];
  const activeAfterToolBeforeAnswer = getInlineWorkingIndicatorActive({
    isStreaming: true,
    isStreamingResponseText: false,
    isToolActive: Boolean(
      Object.keys(toolEndedRun?.activeToolCalls ?? {}).length,
    ),
    hasRunningTask: Object.values(state.tasksByRunId[runId] ?? {}).some(
      (task) => task.status === "running",
    ),
  });

  return {
    rawStatusText: statusEvent.statusText as string,
    rawToolStartStatusText: toolStartEvent.statusText,
    rawToolEndName: toolEndEvent.toolName,
    activeBeforeTool,
    activeDuringTool,
    activeAfterToolBeforeAnswer,
    statusAfterToolEnd: toolEndedRun?.statusText ?? null,
    persistedToolEvent: recordedRunEvents.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "tool_start",
    ),
    displayStatus: displayStatusDuringTool,
  };
};

describe("subscribeRuntimeAgentEvents", () => {
  it("displays real runtime tool status text with friendly working indicator copy", async () => {
    const web = await runToolStatusIntegration("web");
    expect(web.rawStatusText).toBe("Running Web");
    expect(web.rawToolStartStatusText).toBe("Running Web");
    expect(web.rawToolEndName).toBe("web");
    expect(web.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "web" }),
    );
    expect(web.activeBeforeTool).toBe(true);
    expect(web.activeDuringTool).toBe(true);
    // Gap after a fast tool returns: keep showing the thinking label rather
    // than going blank until the next tool/answer.
    expect(web.activeAfterToolBeforeAnswer).toBe(true);
    expect(web.statusAfterToolEnd).toBeNull();
    expect(web.displayStatus).toBe("Searching");

    const spawnAgent = await runToolStatusIntegration("spawn_agent");
    expect(spawnAgent.rawStatusText).toBe("Running Spawn Agent");
    expect(spawnAgent.rawToolStartStatusText).toBe("Running Spawn Agent");
    expect(spawnAgent.rawToolEndName).toBe("spawn_agent");
    expect(spawnAgent.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "spawn_agent" }),
    );
    expect(spawnAgent.activeBeforeTool).toBe(true);
    expect(spawnAgent.activeDuringTool).toBe(true);
    expect(spawnAgent.activeAfterToolBeforeAnswer).toBe(true);
    expect(spawnAgent.statusAfterToolEnd).toBeNull();
    expect(spawnAgent.displayStatus).toBe("On it");

    const sendInput = await runToolStatusIntegration("send_input");
    expect(sendInput.rawStatusText).toBe("Running Send Input");
    expect(sendInput.rawToolStartStatusText).toBe("Running Send Input");
    expect(sendInput.rawToolEndName).toBe("send_input");
    expect(sendInput.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "send_input" }),
    );
    expect(sendInput.activeBeforeTool).toBe(true);
    expect(sendInput.activeDuringTool).toBe(true);
    expect(sendInput.activeAfterToolBeforeAnswer).toBe(true);
    expect(sendInput.statusAfterToolEnd).toBeNull();
    expect(sendInput.displayStatus).toBe("On it");
  });

  it("steps back while a spawned sub-agent task runs, then resumes thinking once it finishes", () => {
    const runId = "run-update-agent";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId: "conversation-1",
      userMessageId: "user-1",
    });
    state = streamStoreReducer(state, {
      type: "run-status",
      runId,
      statusText: "Resume current Nvidia web research test again",
    });

    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
        hasRunningTask: Object.values(current.tasksByRunId[runId] ?? {}).some(
          (task) => task.status === "running",
        ),
      });

    // Pre-tool thinking: the orchestrator line is active.
    expect(activeFor(state)).toBe(true);

    // A spawned sub-agent starts working — its own task chip covers it, so
    // the orchestrator line steps back instead of pinning "thinking".
    state = streamStoreReducer(state, {
      type: "task-upsert",
      runId,
      conversationId: "conversation-1",
      userMessageId: "user-1",
      task: {
        id: "agent-1",
        description: "long research task",
        agentType: AGENT_IDS.GENERAL,
        status: "running",
        startedAtMs: 1_000,
        lastUpdatedAtMs: 1_000,
      },
    });
    expect(activeFor(state)).toBe(false);

    // The sub-agent finishes — the orchestrator is thinking again in the gap.
    state = streamStoreReducer(state, {
      type: "task-upsert",
      runId,
      conversationId: "conversation-1",
      userMessageId: "user-1",
      task: {
        id: "agent-1",
        description: "long research task",
        agentType: AGENT_IDS.GENERAL,
        status: "completed",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
        lastUpdatedAtMs: 2_000,
      },
    });
    expect(activeFor(state)).toBe(true);
  });

  it("keeps the working indicator alive in reasoning gaps after an interim/preamble message", () => {
    const runId = "run-preamble";
    const conversationId = "conversation-1";
    // Derive the indicator gate the same way the renderer does: the
    // streaming-text flag lives on the run record.
    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: !current.runsById[runId]?.terminal,
        isStreamingResponseText: Boolean(
          current.runsById[runId]?.isStreamingText,
        ),
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
        hasRunningTask: false,
      });

    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });
    // Pre-text thinking shows the indicator.
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // Model streams a preamble ("Let me check…") — indicator steps aside.
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(true);
    expect(activeFor(state)).toBe(false);

    // A tool starts: the streaming-text flag resets and the tool label shows.
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-1",
      toolName: "web",
    });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // Tool ends — this is the hole: with the old "any text this run" signal
    // the indicator went blank here. It must keep showing the thinking label.
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-1",
      toolName: "web",
    });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // Final answer streams — indicator steps aside again.
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(activeFor(state)).toBe(false);
  });

  it("clears the in-flight tool even when tool-end is keyed differently than tool-start", () => {
    const runId = "run-tool-mismatch";
    const conversationId = "conversation-1";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });

    // Start keyed by toolCallId, end carries only the toolName.
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-abc",
      toolName: "web",
    });
    expect(Object.keys(state.runsById[runId]?.activeToolCalls ?? {})).toEqual([
      "call-abc",
    ]);
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolName: "web",
    });
    expect(state.runsById[runId]?.activeToolCalls).toEqual({});

    // End carrying an unrelated id still closes the single in-flight tool.
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-def",
      toolName: "read",
    });
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "stale-id",
    });
    expect(state.runsById[runId]?.activeToolCalls).toEqual({});
  });

  it("records a completed assistant text event without a Pi message object", () => {
    const store = { recordRunEvent: vi.fn() };
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-claude",
      conversationId: "conversation-1",
      agentType: "orchestrator",
      userMessageId: "user-1",
      getResponseTarget: () => ({ type: "user_turn" }),
    });

    recorder.recordStream("Hello ");
    const event = recorder.recordAssistantTextEnd(" Hello from Claude Code. ");

    expect(event).toEqual(
      expect.objectContaining({
        runId: "run-claude",
        agentType: "orchestrator",
        seq: 2,
        userMessageId: "user-1",
        text: "Hello from Claude Code.",
        responseTarget: { type: "user_turn" },
      }),
    );
  });

  it("routes provider thinking_delta to onReasoning (NOT onStream) and skips thinking_end", () => {
    // Reasoning deltas feed the per-agent reasoning UI, not the visible chat stream.
    let listener: ((event: AgentEvent) => void) | undefined;
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    };
    const store = { recordRunEvent: vi.fn() };
    const onReasoning = vi.fn();
    const onStream = vi.fn();

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder: createRunEventRecorder({
        store: store as never,
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "general",
        userMessageId: "user-1",
      }),
      callbacks: {
        onReasoning,
        onStream,
      },
    });

    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Need to inspect the task.",
        partial: assistantMessage,
      },
    });
    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Need to inspect the task.",
        partial: assistantMessage,
      },
    });
    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Done.",
        partial: {
          ...assistantMessage,
          content: [
            assistantMessage.content[0],
            { type: "text" as const, text: "Done." },
          ],
        },
      },
    });

    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(onReasoning).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "Need to inspect the task." }),
    );
    expect(onReasoning).not.toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "" }),
    );
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "Done." }),
    );
  });

  it("skips empty thinking_delta chunks", () => {
    let listener: ((event: AgentEvent) => void) | undefined;
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    };
    const store = { recordRunEvent: vi.fn() };
    const onReasoning = vi.fn();

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder: createRunEventRecorder({
        store: store as never,
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "general",
        userMessageId: "user-1",
      }),
      callbacks: { onReasoning },
    });

    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "",
        partial: assistantMessage,
      },
    });

    expect(onReasoning).not.toHaveBeenCalled();
  });
});
