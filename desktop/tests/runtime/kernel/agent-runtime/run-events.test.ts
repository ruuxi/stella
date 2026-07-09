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

    // Recall is the orchestrator's longest wait (delegates to a recall
    // agent); the indicator must read as memory-digging, not a generic
    // thinking/working verb, and revert to normal labels once it returns.
    const recall = await runToolStatusIntegration("Recall");
    expect(recall.rawStatusText).toBe("Running Recall");
    expect(recall.rawToolStartStatusText).toBe("Running Recall");
    expect(recall.rawToolEndName).toBe("Recall");
    expect(recall.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "Recall" }),
    );
    expect(recall.activeBeforeTool).toBe(true);
    expect(recall.activeDuringTool).toBe(true);
    expect(recall.activeAfterToolBeforeAnswer).toBe(true);
    expect(recall.statusAfterToolEnd).toBeNull();
    expect(recall.displayStatus).toBe("Searching my memory");
    // Direct tool-name path: TOOL_START carries the runtime's PascalCase
    // name, which must normalize onto the recall phrase pool.
    expect(
      getWorkingIndicatorDisplayStatus({ toolName: "Recall", toolCallId: "" }),
    ).toBe("Searching my memory");

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

  it("keeps the indicator up while a spawned sub-agent runs (no early dismiss)", () => {
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
        isStreamingResponseText: Boolean(
          current.runsById[runId]?.isStreamingText,
        ),
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
      });

    // Pre-tool thinking: the orchestrator line is active.
    expect(activeFor(state)).toBe(true);

    // A spawned sub-agent starts working. The orchestrator's own indicator
    // must STAY up — it only hands off once the assistant's first character
    // is painted, regardless of background/spawned work.
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
    expect(activeFor(state)).toBe(true);

    // The sub-agent finishes — still thinking, still visible.
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

    // Only the painted first character hands off.
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(activeFor(state)).toBe(false);
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

  it("re-arms the working indicator at a preamble→tool-call boundary before the tool starts", () => {
    const runId = "run-preamble-boundary";
    const conversationId = "conversation-1";
    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: !current.runsById[runId]?.terminal,
        isStreamingResponseText: Boolean(
          current.runsById[runId]?.isStreamingText,
        ),
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
      });

    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });

    // Model streams a preamble ("Let me check…") — indicator steps aside as
    // the painted text takes over.
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(true);
    expect(activeFor(state)).toBe(false);

    // The preamble message finalizes and it ends with a tool call. Without
    // the re-arm the indicator would stay dismissed over the painted
    // preamble until `tool-start` lands (a visible gap where nothing shows).
    // The boundary clears the streaming-text flag so the indicator returns
    // immediately.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
      followedByToolCall: true,
    });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // The tool then starts (redundant reset — indicator already showing).
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-1",
      toolName: "web",
    });
    expect(activeFor(state)).toBe(true);
  });

  it("keeps the indicator up when the preamble boundary is processed before the paint (live ordering)", () => {
    const runId = "run-preamble-race";
    const conversationId = "conversation-1";
    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: !current.runsById[runId]?.terminal,
        isStreamingResponseText: Boolean(
          current.runsById[runId]?.isStreamingText,
        ),
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
      });

    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });

    // Live, the preamble→tool boundary event arrives over IPC before the
    // reveal's async first-paint rAF fires, so `isStreamingText` is still
    // false at boundary time. The re-arm must still take effect.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
      followedByToolCall: true,
    });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // The finalized preamble's late first paint now fires — it must NOT
    // re-suppress the indicator (that would reopen the dead gap before the
    // tool starts).
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // Tool starts: still up. The preamble-paint suppression is held (not
    // released here) so a late paint delivered after tool-start can't stick.
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-1",
      toolName: "spawn_agent",
    });
    expect(activeFor(state)).toBe(true);

    // Tool ends: still thinking, still up. The suppression is released now
    // that the tool phase is over.
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-1",
      toolName: "spawn_agent",
    });
    expect(activeFor(state)).toBe(true);

    // The post-tool answer's own paint hands off normally.
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(true);
    expect(activeFor(state)).toBe(false);
  });

  it("keeps the indicator up when the preamble paint is delivered after tool-start (spawn_agent post-tool gap)", () => {
    const runId = "run-preamble-paint-after-tool-start";
    const conversationId = "conversation-1";
    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: !current.runsById[runId]?.terminal,
        isStreamingResponseText: Boolean(
          current.runsById[runId]?.isStreamingText,
        ),
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
      });

    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });

    // Boundary and tool-start both drain from the same IPC batch before the
    // reveal's first-paint rAF fires — so the preamble's paint is still
    // pending when the tool has already started.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
      followedByToolCall: true,
    });
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-1",
      toolName: "spawn_agent",
    });
    expect(activeFor(state)).toBe(true);

    // The finalized preamble's late first paint now lands — AFTER tool-start.
    // It must NOT set `isStreamingText`, or the flag sticks true through the
    // whole tool and blanks the indicator once the tool ends (dead air).
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // Tool ends: the post-tool reasoning gap must still show the indicator —
    // this is the exact window that was going dead after spawn_agent.
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-1",
      toolName: "spawn_agent",
    });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);
    expect(activeFor(state)).toBe(true);

    // Only the post-tool answer's own fresh paint hands off.
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(true);
    expect(activeFor(state)).toBe(false);
  });

  it("holds the preamble-paint suppression across parallel tools until the last ends", () => {
    const runId = "run-preamble-parallel-tools";
    const conversationId = "conversation-1";
    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: !current.runsById[runId]?.terminal,
        isStreamingResponseText: Boolean(
          current.runsById[runId]?.isStreamingText,
        ),
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
      });

    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
      followedByToolCall: true,
    });
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-a",
      toolName: "web",
    });
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-b",
      toolName: "web",
    });

    // First tool ends while the second is still in flight — the suppression
    // must survive, so a late preamble paint arriving now is still swallowed.
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-a",
      toolName: "web",
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(true);
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(false);

    // Last tool ends: suppression released, post-tool gap still shows up.
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-b",
      toolName: "web",
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(false);
    expect(activeFor(state)).toBe(true);
  });

  it("leaves the hand-off intact for a final-answer boundary (no following tool)", () => {
    const runId = "run-final-boundary";
    const conversationId = "conversation-1";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });
    state = streamStoreReducer(state, { type: "mark-streaming-text", runId });
    expect(state.runsById[runId]?.isStreamingText).toBe(true);

    // A plain boundary (the message did not end with a tool call) must not
    // re-arm the indicator — the run's answer is on screen and handed off.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
    });
    expect(state.runsById[runId]?.isStreamingText).toBe(true);
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

  it("flags a preamble message that ends with a tool call as followedByToolCall", () => {
    const store = { recordRunEvent: vi.fn() };
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-preamble",
      conversationId: "conversation-1",
      agentType: "orchestrator",
      userMessageId: "user-1",
      getResponseTarget: () => ({ type: "user_turn" }),
    });

    const preambleWithTool: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look that up." },
        { type: "toolCall", id: "call-web", name: "web", arguments: {} },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "toolUse",
      timestamp: 7,
    };
    const preambleEvent = recorder.recordAssistantMessageEnd(preambleWithTool);
    expect(preambleEvent?.followedByToolCall).toBe(true);

    // A plain text message (the run's final answer) carries no such flag.
    const finalAnswer = createTextMessage("All done.");
    const finalEvent = recorder.recordAssistantMessageEnd(finalAnswer);
    expect(finalEvent?.text).toBe("All done.");
    expect(finalEvent?.followedByToolCall).toBeUndefined();
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

describe("resumed-thread task labeling", () => {
  const runId = "run-resumed";
  const conversationId = "conversation-1";

  it("names a reasoning-only task from the event description, never bare 'Task'", () => {
    // A resumed legacy thread whose agent-started event was lost (finished
    // root run / restart) rebuilds its activity row from reasoning events.
    let state = streamStoreReducer(initialStoreState, {
      type: "agent-reasoning",
      runId,
      conversationId,
      agentId: "morph-animation-test-rig",
      description: "Morph animation test rig in the dev harness",
      chunk: "scaffolding remotion project structure",
    });
    expect(
      state.tasksByRunId[runId]?.["morph-animation-test-rig"]?.description,
    ).toBe("Morph animation test rig in the dev harness");

    // Without a description on the event, fall back to the de-slugged
    // thread id instead of the generic placeholder.
    state = streamStoreReducer(initialStoreState, {
      type: "agent-reasoning",
      runId,
      conversationId,
      agentId: "morph-animation-test-rig",
      chunk: "scaffolding remotion project structure",
    });
    expect(
      state.tasksByRunId[runId]?.["morph-animation-test-rig"]?.description,
    ).toBe("Morph animation test rig");
  });

  it("upgrades a placeholder description once a real one arrives, and keeps it", () => {
    let state = streamStoreReducer(initialStoreState, {
      type: "agent-reasoning",
      runId,
      conversationId,
      agentId: "task-3",
      chunk: "working",
    });
    expect(state.tasksByRunId[runId]?.["task-3"]?.description).toBe("Task");

    state = streamStoreReducer(state, {
      type: "agent-reasoning",
      runId,
      conversationId,
      agentId: "task-3",
      description: "Compare flight prices",
      chunk: "more work",
    });
    expect(state.tasksByRunId[runId]?.["task-3"]?.description).toBe(
      "Compare flight prices",
    );

    // A later upsert carrying only the generic placeholder must not clobber
    // the real description.
    state = streamStoreReducer(state, {
      type: "task-upsert",
      runId,
      conversationId,
      task: {
        id: "task-3",
        description: "Task",
        agentType: AGENT_IDS.GENERAL,
        status: "running",
        startedAtMs: 1_000,
        lastUpdatedAtMs: 1_000,
      },
    });
    expect(state.tasksByRunId[runId]?.["task-3"]?.description).toBe(
      "Compare flight prices",
    );
  });
});
