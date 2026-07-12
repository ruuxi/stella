import { describe, expect, it } from "vitest";
import {
  hasQueuedMessageEntryPlayed,
  markQueuedMessageEntryPlayed,
} from "@/features/chat/lib/message-entry-animation-state";

describe("message entry animation state", () => {
  it("carries queued entrance playback across the sent-row handoff", () => {
    const messageId = "queued-to-sent-message";

    expect(hasQueuedMessageEntryPlayed(messageId)).toBe(false);
    markQueuedMessageEntryPlayed(messageId);
    expect(hasQueuedMessageEntryPlayed(messageId)).toBe(true);
  });
});
