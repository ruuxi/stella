
import { describe, expect, test } from "bun:test";
import { eventsToHistoryMessages } from "../convex/lib/history_messages";
import { createEventFactory, type EventLike } from "./helpers/history_event_fixtures";

const { makeToolPair } = createEventFactory();

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

    const result = eventsToHistoryMessages(events as unknown as Parameters<typeof eventsToHistoryMessages>[0], {
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: 1, // Always trigger if we save > 20k
      },
    });

    // We expect it to compact "req_huge", but it will fail!
    expect(result.microcompactBoundary?.compactedToolIds).toEqual(["req_huge"]);
  });
});

