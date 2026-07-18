import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalChatHistoryService } from "../../electron/services/local-chat-history-service.js";
import type { SessionStore } from "../../../runtime/kernel/storage/session-store.js";

describe("local agent thread history boundary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("returns only the exact persisted thread and enforces the wire bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-thread-chat-"));
    roots.push(root);
    const service = new LocalChatHistoryService({ stellaAppDir: root });
    const store = (
      service as unknown as { getStore: () => SessionStore }
    ).getStore();

    for (let index = 0; index < 305; index += 1) {
      store.appendThreadMessage({
        threadKey: "exact-agent-thread",
        timestamp: index + 1,
        role: index % 2 === 0 ? "assistant" : "toolResult",
        content: `exact-${index}`,
      });
    }
    store.appendThreadMessage({
      threadKey: "other-agent-thread",
      timestamp: 999,
      role: "assistant",
      content: "must never cross threads",
    });

    const messages = service.listAgentThreadMessages({
      threadId: "exact-agent-thread",
      limit: 5_000,
    });
    expect(messages).toHaveLength(150);
    expect(messages[0]?.content).toContain("exact-6");
    expect(messages.at(-1)?.content).toBe("exact-304");
    expect(JSON.stringify(messages)).not.toContain("must never cross threads");
    expect(() => service.listAgentThreadMessages({ threadId: "   " })).toThrow(
      /threadId is required/,
    );
    service.close();
  });

  it("keeps authored prose while projecting real Claude transport and lifecycle shapes structurally", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-thread-chat-"));
    roots.push(root);
    const service = new LocalChatHistoryService({ stellaAppDir: root });
    const store = (
      service as unknown as { getStore: () => SessionStore }
    ).getStore();
    const threadId = "manager-engine-projection";

    for (const [index, engine] of [
      {
        label: "Stella-native",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
      },
      {
        label: "Codex",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "codex",
      },
    ].entries()) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 100 + index * 2,
        role: "assistant",
        content: "",
        payload: {
          role: "assistant",
          content: [
            { type: "text", text: `${engine.label} preamble` },
            {
              type: "toolCall",
              id: `spawn-${index}`,
              name: "spawn_agent",
              arguments: {
                description: "Raw child task",
                prompt: "Transport payload",
              },
            },
            { type: "text", text: `${engine.label} continuation` },
          ],
          api: engine.api,
          provider: engine.provider,
          model: engine.model,
          usage: {
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
          },
          stopReason: "toolUse",
          timestamp: 100 + index * 2,
          stellaAttemptGeneration: 1,
        } as never,
      });
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 101 + index * 2,
        role: "toolResult",
        toolCallId: `spawn-${index}`,
        content: '{"childThreadId":"internal-child"}',
      });
    }

    // Live Claude Code history stores authored prose, native tool calls, and
    // native tool results as three distinct structured entries. Preserve the
    // text entry and hide the transport entries without inspecting strings.
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 110,
      role: "assistant",
      content: "Claude Code preamble",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "Claude Code preamble" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 110,
      } as never,
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 111,
      role: "assistant",
      content: "",
      payload: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "claude-native-spawn",
            name: "spawn_agent",
            arguments: { description: "Raw Claude child", prompt: "Private" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 111,
      } as never,
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 112,
      role: "toolResult",
      toolCallId: "claude-native-spawn",
      content: '{"thread_id":"private-claude-child"}',
      payload: {
        role: "toolResult",
        toolCallId: "claude-native-spawn",
        toolName: "spawn_agent",
        content: [{ type: "text", text: '{"thread_id":"private-claude-child"}' }],
        isError: false,
        timestamp: 112,
      } as never,
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 113,
      role: "assistant",
      content: "Claude Code continuation",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "Claude Code continuation" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 113,
      } as never,
    });

    for (const [offset, type, payload] of [
      [
        0,
        "agent-started",
        {
          agentId: "child",
          agentType: "general",
          description: "Inspect child",
          attemptGeneration: 1,
        },
      ],
      [
        1,
        "agent-completed",
        { agentId: "child", result: "Child finished", attemptGeneration: 1 },
      ],
    ] as const) {
      const eventId = `child:1:${type}`;
      store.appendEvent({
        conversationId: "conv-engine-projection",
        eventId,
        timestamp: 200 + offset,
        type,
        payload,
      });
      store.appendThreadCustomMessage({
        threadKey: threadId,
        timestamp: 200 + offset,
        customType: "runtime.task_lifecycle",
        content: `<system_reminder> ${type} raw coordination`,
        display: false,
        eventId,
      });
    }

    const messages = service.listAgentThreadMessages({ threadId });
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([
      "Stella-native preamble\n\nStella-native continuation",
      "Codex preamble\n\nCodex continuation",
      "Claude Code preamble",
      "Claude Code continuation",
    ]);
    expect(
      messages.filter((message) => message.role === "lifecycle"),
    ).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toMatch(
      /spawn_agent|Raw child task|Raw Claude child|Transport payload|Private|childThreadId|private-claude-child|system_reminder|\[Tool call\]|\[Tool result\]/,
    );
    service.close();
  });

  it("suppresses a reconstructed Claude Code checkpoint containing native tool transport after reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-thread-chat-"));
    roots.push(root);
    let service = new LocalChatHistoryService({ stellaAppDir: root });
    const store = (
      service as unknown as { getStore: () => SessionStore }
    ).getStore();
    const threadId = "claude-native-checkpoint";
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_000,
      role: "assistant",
      content: "",
      payload: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "claude-native-spawn",
            name: "spawn_agent",
            arguments: { description: "Native child", prompt: "Raw prompt" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1_000,
      } as never,
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_001,
      role: "toolResult",
      toolCallId: "claude-native-spawn",
      content: '{"thread_id":"native-child","running_in_background":true}',
    });
    const toolEntries = store.loadThreadMessagesWithEntryTypes(threadId);
    expect(toolEntries.map((entry) => entry.sourceEntryType)).toEqual([
      "message",
      "message",
    ]);
    store.compactThread({
      threadKey: threadId,
      summary:
        '[Tool call] spawn_agent\nargs: {"description":"Native child"}\n\n[Tool result] spawn_agent\n{"thread_id":"native-child"}',
      fromEntryId: toolEntries[0]!.entryId!,
      toEntryId: toolEntries[1]!.entryId!,
      tokensBefore: 500,
      timestamp: 1_002,
    });
    expect(
      store.loadThreadMessagesWithEntryTypes(threadId).find((entry) =>
        entry.content.startsWith("[[THREAD_CHECKPOINT]]"),
      )?.sourceEntryType,
    ).toBe("compaction");
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_003,
      role: "assistant",
      content: "Claude authored conclusion.",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "Claude authored conclusion." }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1_003,
      } as never,
    });

    expect(service.listAgentThreadMessages({ threadId })).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Claude authored conclusion.",
      }),
    ]);
    service.close();

    service = new LocalChatHistoryService({ stellaAppDir: root });
    const reloaded = service.listAgentThreadMessages({ threadId });
    expect(reloaded).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Claude authored conclusion.",
      }),
    ]);
    expect(JSON.stringify(reloaded)).not.toMatch(
      /spawn_agent|Native child|native-child|\[Tool call\]|\[Tool result\]/,
    );
    service.close();
  });
});
