import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eventsToHistoryMessages } from "../convex/lib/history_messages";
import { createEventFactory, type EventLike } from "./helpers/history_event_fixtures";

const { makeEvent, makeToolPair, reset } = createEventFactory();

const originalDisable = process.env.DISABLE_MICROCOMPACT;

beforeEach(() => {
  reset();
  delete process.env.DISABLE_MICROCOMPACT;
});

afterAll(() => {
  if (originalDisable === undefined) {
    delete process.env.DISABLE_MICROCOMPACT;
  } else {
    process.env.DISABLE_MICROCOMPACT = originalDisable;
  }
});

describe("history microcompact", () => {
  test("auto mode compacts oldest eligible tool results and protects latest three", () => {
    const events: EventLike[] = [];
    for (let i = 1; i <= 7; i += 1) {
      events.push(...makeToolPair(`req_${i}`));
    }

    const result = eventsToHistoryMessages(events as unknown as Parameters<typeof eventsToHistoryMessages>[0], {
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
      "req_4",
    ]);
    expect(result.microcompactBoundary?.clearedAttachmentUUIDs).toEqual([]);
    expect(result.microcompactBoundary?.tokensSaved ?? 0).toBeGreaterThan(20_000);

    const trimmedMessages = result.messages.filter((message) =>
      message.content.includes("<microcompact_trimmed>"),
    );
    expect(trimmedMessages).toHaveLength(4);
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

    const result = eventsToHistoryMessages(events as unknown as Parameters<typeof eventsToHistoryMessages>[0], {
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

    const result = eventsToHistoryMessages(events as unknown as Parameters<typeof eventsToHistoryMessages>[0], {
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

    const result = eventsToHistoryMessages(events as unknown as Parameters<typeof eventsToHistoryMessages>[0], {
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
