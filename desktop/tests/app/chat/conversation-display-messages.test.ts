import { describe, expect, it } from "vitest";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat";
import type { StreamingAssistantOverlay } from "@/app/chat/streaming/streaming-types";
import {
  getPersistedAssistantSlots,
  mergeConversationDisplayMessageSources,
  overlayToMessageRecord,
} from "@/app/chat/hooks/use-conversation-display-messages";

const message = (overrides: Partial<MessageRecord>): MessageRecord => ({
  _id: overrides._id ?? "message",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "assistant_message",
  payload: overrides.payload ?? {},
  toolEvents: overrides.toolEvents ?? [],
  ...overrides,
});

const overlay = (
  overrides: Partial<StreamingAssistantOverlay>,
): StreamingAssistantOverlay => ({
  _id: overrides._id ?? "stream-overlay:u1:1",
  userMessageId: overrides.userMessageId ?? "u1",
  indexInTurn: overrides.indexInTurn ?? 1,
  text: overrides.text ?? "streamed text",
  timestamp: overrides.timestamp ?? 2,
  runId: overrides.runId ?? "run-1",
  ...overrides,
});

describe("conversation display message merge", () => {
  it("keeps the live streamed row visible after the persisted twin lands", () => {
    const persisted = message({
      _id: "assistant-msg-run-1-10",
      timestamp: 3,
      payload: {
        text: "stored text",
        userMessageId: "u1",
        selfModApplied: { featureId: "f1", files: ["a.ts"], batchIndex: 0 },
      },
      toolEvents: [
        message({
          _id: "tool-1",
          timestamp: 4,
          type: "tool_result",
          payload: { toolName: "exec_command" },
        }),
      ],
    });
    const live = overlay({
      text: "streamed text",
      locked: true,
      timestamp: 2,
    });
    const liveMessage = overlayToMessageRecord(live, persisted);

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [
        message({ _id: "u1", type: "user_message" }),
        persisted,
      ],
      overlayMessages: [liveMessage],
      streamingAssistants: [live],
      persistedAssistantSlots: getPersistedAssistantSlots([persisted]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "u1",
      "stream-overlay:u1:1",
    ]);
    expect(merged[1]!.payload?.text).toBe("streamed text");
    expect(merged[1]!.payload?.selfModApplied).toEqual({
      featureId: "f1",
      files: ["a.ts"],
      batchIndex: 0,
    });
    expect(merged[1]!.toolEvents.map((event) => event._id)).toEqual(["tool-1"]);
  });

  it("marks locked live rows as no longer actively streaming", () => {
    const liveMessage = overlayToMessageRecord(
      overlay({ locked: true }),
      message({
        payload: {
          userMessageId: "u1",
          text: "stored text",
          metadata: { runtime: { responseTarget: { type: "user_turn" } } },
        },
      }),
    );

    expect(liveMessage.payload?.text).toBe("streamed text");
    expect(liveMessage.payload?.metadata).toMatchObject({
      runtime: {
        isStreaming: false,
        responseTarget: { type: "user_turn" },
      },
    });
  });
});
