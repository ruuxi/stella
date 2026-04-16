import { describe, expect, it } from "vitest";
import {
  formatThreadCheckpointMessage,
  splitThreadMessagesForCompaction,
} from "../../../../runtime/kernel/thread-runtime.js";
import type { PersistedRuntimeThreadPayload } from "../../../../runtime/kernel/storage/shared.js";

const zeroUsage = {
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

const createUserPayload = (
  content: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "user",
  content,
  timestamp,
});

const createAssistantToolCallPayload = (
  toolCallId: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: toolCallId,
      name: "Read",
      arguments: { path: "src/example.ts" },
    },
  ],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: zeroUsage,
  stopReason: "toolUse",
  timestamp,
});

const createAssistantTextPayload = (
  text: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp,
});

const createToolResultPayload = (
  toolCallId: string,
  text: string,
  timestamp: number,
): PersistedRuntimeThreadPayload => ({
  role: "toolResult",
  toolCallId,
  toolName: "Read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});

describe("thread-runtime compaction planning", () => {
  it("keeps assistant tool calls and tool results in the same compacted segment", () => {
    const plan = splitThreadMessagesForCompaction(
      [
        {
          entryId: "m1",
          timestamp: 1,
          role: "user",
          content: "Head message",
          payload: createUserPayload("Head message", 1),
        },
        {
          entryId: "m2",
          timestamp: 2,
          role: "assistant",
          content: "Read(src/example.ts)",
          payload: createAssistantToolCallPayload("call-1", 2),
        },
        {
          entryId: "m3",
          timestamp: 3,
          role: "toolResult",
          content: "File contents",
          toolCallId: "call-1",
          payload: createToolResultPayload("call-1", "File contents", 3),
        },
        {
          entryId: "m4",
          timestamp: 4,
          role: "user",
          content: "Most recent user message",
          payload: createUserPayload("Most recent user message", 4),
        },
      ],
      1,
      1,
      1,
    );

    expect(plan).toMatchObject({
      fromEntryId: "m2",
      toEntryId: "m3",
    });
    expect(plan?.middleMessages.map((message) => message.entryId)).toEqual([
      "m2",
      "m3",
    ]);
  });

  it("reuses an existing checkpoint summary on subsequent compactions", () => {
    const plan = splitThreadMessagesForCompaction(
      [
        {
          entryId: "m1",
          timestamp: 1,
          role: "user",
          content: "Head message",
          payload: createUserPayload("Head message", 1),
        },
        {
          entryId: "m2",
          timestamp: 2,
          role: "assistant",
          content: formatThreadCheckpointMessage({ summary: "Earlier summary" }),
        },
        {
          entryId: "m3",
          timestamp: 3,
          role: "user",
          content: "Older message",
          payload: createUserPayload("Older message", 3),
        },
        {
          entryId: "m4",
          timestamp: 4,
          role: "assistant",
          content: "Worked on the task",
          payload: createAssistantTextPayload("Worked on the task", 4),
        },
        {
          entryId: "m5",
          timestamp: 5,
          role: "user",
          content: "Tail message",
          payload: createUserPayload("Tail message", 5),
        },
      ],
      1,
      1,
      1,
    );

    expect(plan).toMatchObject({
      previousSummary: "Earlier summary",
      fromEntryId: "m3",
      toEntryId: "m4",
    });
    expect(plan?.middleMessages.map((message) => message.entryId)).toEqual([
      "m3",
      "m4",
    ]);
  });
});
