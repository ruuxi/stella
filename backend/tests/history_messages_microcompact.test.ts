import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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

let seq = 0;
const nextId = () => {
  seq += 1;
  return `evt_${seq}`;
};

const makeEvent = (args: Partial<EventLike>): EventLike => ({
  _id: nextId(),
  _creationTime: Date.now(),
  conversationId: "conv_1",
  timestamp: seq + 1,
  type: "assistant_message",
  payload: {},
  ...args,
});

const makeToolPair = (requestId: string, resultChars = 64_000): EventLike[] => [
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

const originalDisable = process.env.DISABLE_MICROCOMPACT;
const originalFeatureFlag = process.env.TENGU_CACHE_PLUM_VIOLET;

beforeEach(() => {
  seq = 0;
  delete process.env.DISABLE_MICROCOMPACT;
  delete process.env.TENGU_CACHE_PLUM_VIOLET;
});

afterAll(() => {
  if (originalDisable === undefined) {
    delete process.env.DISABLE_MICROCOMPACT;
  } else {
    process.env.DISABLE_MICROCOMPACT = originalDisable;
  }
  if (originalFeatureFlag === undefined) {
    delete process.env.TENGU_CACHE_PLUM_VIOLET;
  } else {
    process.env.TENGU_CACHE_PLUM_VIOLET = originalFeatureFlag;
  }
});

describe("history microcompact", () => {
  test("auto mode compacts oldest eligible tool results and protects latest three", () => {
    const events: EventLike[] = [];
    for (let i = 1; i <= 7; i += 1) {
      events.push(...makeToolPair(`req_${i}`));
    }

    const result = eventsToHistoryMessages(events as any, {
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: 1,
      },
    });

    expect(result.microcompactBoundary).toBeDefined();
    expect(result.microcompactBoundary?.compactedToolIds).toEqual([
      "req_1",
      "req_2",
      "req_3",
    ]);
    expect(result.microcompactBoundary?.clearedAttachmentUUIDs).toEqual([]);
    expect(result.microcompactBoundary?.tokensSaved ?? 0).toBeGreaterThan(20_000);

    const trimmedMessages = result.messages.filter((message) =>
      message.content.includes("<microcompact_trimmed>"),
    );
    expect(trimmedMessages).toHaveLength(3);
  });

  test("replays prior microcompact boundaries so already-compacted ids stay trimmed", () => {
    const events: EventLike[] = [
      makeEvent({
        type: "microcompact_boundary",
        payload: {
          trigger: "auto",
          preTokens: 55_000,
          tokensSaved: 23_000,
          compactedToolIds: ["req_1"],
          clearedAttachmentUUIDs: [],
        },
      }),
      ...makeToolPair("req_1"),
      ...makeToolPair("req_2"),
      ...makeToolPair("req_3"),
    ];

    const result = eventsToHistoryMessages(events as any, {
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: 999_999,
      },
    });

    expect(result.microcompactBoundary).toBeUndefined();
    const joined = result.messages.map((message) => message.content).join("\n\n");
    expect(joined).toContain("request_id: req_1");
    expect(joined).toContain("<microcompact_trimmed>");
  });

  test("manual mode can compact even when savings are below the auto threshold", () => {
    const events: EventLike[] = [];
    for (let i = 1; i <= 4; i += 1) {
      events.push(...makeToolPair(`req_${i}`));
    }

    const result = eventsToHistoryMessages(events as any, {
      microcompact: {
        trigger: "manual",
        keepTokens: 10_000,
      },
    });

    expect(result.microcompactBoundary).toBeDefined();
    expect(result.microcompactBoundary?.compactedToolIds).toEqual(["req_1"]);
    expect(result.microcompactBoundary?.tokensSaved ?? 0).toBeGreaterThan(0);
  });

  test("auto mode does nothing when below warning threshold", () => {
    const events: EventLike[] = [];
    for (let i = 1; i <= 7; i += 1) {
      events.push(...makeToolPair(`req_${i}`));
    }

    const result = eventsToHistoryMessages(events as any, {
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: 300_000,
      },
    });

    expect(result.microcompactBoundary).toBeUndefined();
    const trimmedMessages = result.messages.filter((message) =>
      message.content.includes("<microcompact_trimmed>"),
    );
    expect(trimmedMessages).toHaveLength(0);
  });
});
