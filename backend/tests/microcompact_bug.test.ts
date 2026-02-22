
import { describe, expect, test } from "bun:test";
import { eventsToHistoryMessages } from "../convex/agent/history_messages";

type EventLike = {
  _id: string;
  _creationTime: number;
  conversationId: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
  targetDeviceId?: string;
  deviceId?: string;
};

const makeEvent = (args: Partial<EventLike>): EventLike => ({
  _id: "evt_1",
  _creationTime: Date.now(),
  conversationId: "conv_1",
  timestamp: 1,
  type: "assistant_message",
  payload: {},
  ...args,
});

const makeToolPair = (requestId: string, resultChars = 400_000): EventLike[] => [
  makeEvent({
    type: "tool_request",
    requestId,
    payload: {
      toolName: "Read",
      args: { file_path: `/tmp/${requestId}.ts` },
      agentType: "orchestrator",
    },
  }),
  makeEvent({
    type: "tool_result",
    requestId,
    payload: {
      toolName: "Read",
      result: "x".repeat(resultChars),
      agentType: "orchestrator",
    },
  }),
];

describe("history microcompact bug", () => {
  test("fails to compact a single massive tool result due to 8k clamping", () => {
    // 400,000 chars is ~100,000 tokens.
    // If we only have 2 tool calls, one huge one, and one protected.
    const events: EventLike[] = [
      ...makeToolPair("req_huge", 400_000), 
      // Add more events so warningThreshold is met if it counts correctly.
      ...makeToolPair("req_protected", 100),
      ...makeToolPair("req_protected2", 100),
      ...makeToolPair("req_protected3", 100),
      ...makeToolPair("req_protected4", 100),
    ];

    const result = eventsToHistoryMessages(events as any, {
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: 1, // Always trigger if we save > 20k
      },
    });

    // We expect it to compact "req_huge", but it will fail!
    expect(result.microcompactBoundary?.compactedToolIds).toEqual(["req_huge"]);
  });
});

