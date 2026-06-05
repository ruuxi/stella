import { describe, expect, it, vi } from "vitest";

import { VoiceRuntimeService } from "../../../../runtime/worker/voice/service.js";

const makeService = () => {
  const threadMessages: Array<{
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }> = [];
  const localEvents: Array<Record<string, unknown>> = [];
  const runner = {
    appendThreadMessage: vi.fn((message) => {
      threadMessages.push(message);
    }),
    notifyOrchestratorHistoryChanged: vi.fn(),
    getVoiceOrchestratorConfig: vi.fn(async () => ({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "web",
          description: "Search or fetch the web.",
          parameters: { type: "object" },
        },
      ],
    })),
    executeTool: vi.fn(async () => ({
      result: "Search complete.",
      details: { text: "Search complete." },
    })),
    handleLocalChat: vi.fn(),
    webSearch: vi.fn(),
  };
  const chatStore = {
    appendEvent: vi.fn((event) => {
      localEvents.push(event);
      return { _id: `event-${localEvents.length}`, ...event };
    }),
  };
  const onLocalChatUpdated = vi.fn();
  const service = new VoiceRuntimeService({
    getRunner: () => runner as never,
    getChatStore: () => chatStore as never,
    getDeviceId: () => "device-1",
    onLocalChatUpdated,
    emitAgentEvent: vi.fn(),
    emitSelfModHmrState: vi.fn(),
  });

  return {
    service,
    runner,
    chatStore,
    threadMessages,
    localEvents,
    onLocalChatUpdated,
  };
};

describe("VoiceRuntimeService direct tool execution", () => {
  it("executes only tools from the resolved voice orchestrator catalog", async () => {
    const { service, runner, threadMessages, localEvents, onLocalChatUpdated } =
      makeService();

    await service.getOrchestratorConfig({ conversationId: "conv-1" });
    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-1",
      name: "web",
      args: { query: "latest Stella news" },
    });

    expect(result.output).toBe("Search complete.");
    expect(runner.executeTool).toHaveBeenCalledWith(
      "web",
      { query: "latest Stella news" },
      expect.objectContaining({
        conversationId: "conv-1",
        requestId: "call-1",
        agentType: "orchestrator",
        storageMode: "local",
        allowedToolNames: ["web"],
      }),
    );
    expect(threadMessages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ]);
    expect(threadMessages[0]?.content).toContain("[Tool call] web");
    expect(threadMessages[1]?.content).toContain("[Tool result] web");
    expect(localEvents.map((event) => event.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
    expect(onLocalChatUpdated).toHaveBeenCalledTimes(2);
    expect(runner.notifyOrchestratorHistoryChanged).toHaveBeenCalledWith(
      "conv-1",
    );
  });

  it("returns an error for tools outside the resolved catalog", async () => {
    const { service, runner } = makeService();

    await service.getOrchestratorConfig({ conversationId: "conv-1" });
    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-2",
      name: "perform_action",
      args: { message: "do something" },
    });

    expect(result.error).toContain("not available");
    expect(result.output).toContain("Error:");
    expect(runner.executeTool).not.toHaveBeenCalled();
  });

  it("preserves file metadata from html tool results for chat artifacts", async () => {
    const { service, runner, localEvents } = makeService();
    const filePath = "/Users/me/.stella/outputs/html/nvidia-news.html";
    const fileChanges = [{ path: filePath, kind: { type: "add" as const } }];

    runner.getVoiceOrchestratorConfig.mockResolvedValueOnce({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "html",
          description: "Write HTML.",
          parameters: { type: "object" },
        },
      ],
    });
    runner.executeTool.mockResolvedValueOnce({
      result: `Canvas "NVIDIA News" saved to ${filePath} and opened in the panel.`,
      details: {
        filePath,
        slug: "nvidia-news",
        title: "NVIDIA News",
        createdAt: 1_234,
        bytes: 4096,
      },
      fileChanges,
    });

    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-html",
      name: "html",
      args: {
        slug: "nvidia-news",
        title: "NVIDIA News",
        html: "<!doctype html><html></html>",
      },
    });

    expect(result).toMatchObject({
      details: {
        filePath,
        slug: "nvidia-news",
        title: "NVIDIA News",
      },
      fileChanges,
    });
    const toolResult = localEvents.find(
      (event) => event.type === "tool_result",
    );
    expect(toolResult?.payload).toMatchObject({
      toolName: "html",
      agentType: "orchestrator",
      filePath,
      slug: "nvidia-news",
      title: "NVIDIA News",
      details: {
        filePath,
        slug: "nvidia-news",
        title: "NVIDIA News",
      },
      fileChanges,
    });
  });

  it("preserves image_gen job metadata for inline image cards", async () => {
    const { service, runner, localEvents } = makeService();

    runner.getVoiceOrchestratorConfig.mockResolvedValueOnce({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "image_gen",
          description: "Generate images.",
          parameters: { type: "object" },
        },
      ],
    });
    runner.executeTool.mockResolvedValueOnce({
      result: "image_gen job job-1 submitted. The generated image will appear automatically when it finishes.",
      details: {
        jobId: "job-1",
        capability: "text_to_image",
        prompt: "a product mockup",
        numImages: 3,
        status: "submitted",
      },
    });

    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-image",
      name: "image_gen",
      args: {
        prompt: "a product mockup",
        num_images: 3,
      },
    });

    expect(result.details).toMatchObject({
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a product mockup",
      numImages: 3,
      status: "submitted",
    });
    const toolResult = localEvents.find(
      (event) => event.type === "tool_result",
    );
    expect(toolResult?.payload).toMatchObject({
      toolName: "image_gen",
      agentType: "orchestrator",
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a product mockup",
      numImages: 3,
      details: {
        jobId: "job-1",
        prompt: "a product mockup",
      },
      result: {
        jobId: "job-1",
        prompt: "a product mockup",
      },
    });
  });

  it("preserves generic artifact side effects from other tools", async () => {
    const { service, runner, localEvents } = makeService();
    const producedFiles = [
      { path: "/Users/me/Desktop/deck.pptx", kind: { type: "add" as const } },
    ];
    const officePreviewRef = {
      sessionId: "office-session-1",
      title: "deck.pptx",
      sourcePath: "/Users/me/Desktop/deck.pptx",
    };

    runner.getVoiceOrchestratorConfig.mockResolvedValueOnce({
      instructions: "orchestrator instructions",
      tools: [
        {
          type: "function" as const,
          name: "exec_command",
          description: "Run a command.",
          parameters: { type: "object" },
        },
      ],
    });
    runner.executeTool.mockResolvedValueOnce({
      result: "Created deck.pptx",
      details: {
        officePreviewRef,
      },
      producedFiles,
    });

    const result = await service.executeTool({
      requestId: "voice-session-1",
      conversationId: "conv-1",
      callId: "call-shell",
      name: "exec_command",
      args: { cmd: "make deck" },
    });

    expect(result).toMatchObject({
      details: { officePreviewRef },
      producedFiles,
    });
    const toolResult = localEvents.find(
      (event) => event.type === "tool_result",
    );
    expect(toolResult?.payload).toMatchObject({
      toolName: "exec_command",
      agentType: "orchestrator",
      officePreviewRef,
      producedFiles,
      details: {
        officePreviewRef,
      },
    });
  });

  it("marks text orchestrator history stale after persisted voice transcript", () => {
    const { service, runner, localEvents } = makeService();

    service.persistTranscript({
      conversationId: "conv-1",
      role: "user",
      text: "Please check this from voice.",
      uiVisibility: "visible",
    });

    expect(runner.appendThreadMessage).toHaveBeenCalledWith({
      threadKey: "conv-1",
      role: "user",
      content: "Please check this from voice.",
    });
    expect(runner.notifyOrchestratorHistoryChanged).toHaveBeenCalledWith(
      "conv-1",
    );
    expect(localEvents[0]).toMatchObject({
      type: "user_message",
      payload: {
        text: "Please check this from voice.",
        source: "voice",
        metadata: { ui: { visibility: "visible" } },
      },
    });
  });

  it("persists structured voiceSession metadata on the end-of-session summary", () => {
    const { service, localEvents } = makeService();

    service.persistTranscript({
      conversationId: "conv-1",
      role: "assistant",
      text: "Voice session\n\nDuration: 1m 24s",
      uiVisibility: "visible",
      voiceSession: { durationMs: 84_000 },
    });

    expect(localEvents[0]).toMatchObject({
      type: "assistant_message",
      payload: {
        text: "Voice session\n\nDuration: 1m 24s",
        source: "voice",
        metadata: {
          ui: { visibility: "visible" },
          voiceSession: { durationMs: 84_000 },
        },
      },
    });
  });
});
