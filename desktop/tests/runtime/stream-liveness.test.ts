import { describe, expect, it } from "vitest";
import { shouldVerifyStreamingLiveness } from "../../src/app/chat/streaming/stream-liveness";

describe("shouldVerifyStreamingLiveness", () => {
  it("checks liveness only when streaming is otherwise idle", () => {
    expect(
      shouldVerifyStreamingLiveness({
        isStreaming: true,
        activeConversationId: "conv-1",
        pendingStartCount: 0,
        queuedRunCount: 0,
        liveTaskCount: 0,
        runtimeStatusText: null,
        streamingText: "",
        reasoningText: "",
      }),
    ).toBe(true);
  });

  it("skips liveness checks while a start request is still pending", () => {
    expect(
      shouldVerifyStreamingLiveness({
        isStreaming: true,
        activeConversationId: "conv-1",
        pendingStartCount: 1,
        queuedRunCount: 0,
        liveTaskCount: 0,
        runtimeStatusText: null,
        streamingText: "",
        reasoningText: "",
      }),
    ).toBe(false);
  });

  it("skips liveness checks while visible activity remains", () => {
    expect(
      shouldVerifyStreamingLiveness({
        isStreaming: true,
        activeConversationId: "conv-1",
        pendingStartCount: 0,
        queuedRunCount: 0,
        liveTaskCount: 1,
        runtimeStatusText: null,
        streamingText: "",
        reasoningText: "",
      }),
    ).toBe(false);
  });
});
