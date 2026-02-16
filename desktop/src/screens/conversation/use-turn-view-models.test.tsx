import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventRecord } from "../../hooks/use-conversation-events";
import { useTurnViewModels } from "./use-turn-view-models";

const createEvent = (
  overrides: Partial<EventRecord> & { type: string },
): EventRecord => ({
  _id: `event-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  ...overrides,
});

describe("useTurnViewModels", () => {
  it("maps channel envelope metadata into turn view model", () => {
    const userId = "user-1";
    const events: EventRecord[] = [
      {
        _id: userId,
        timestamp: 1,
        type: "user_message",
        payload: { text: "hello" },
        channelEnvelope: {
          provider: "discord",
          kind: "message",
          externalUserId: "ext-1",
        },
      },
      createEvent({
        type: "assistant_message",
        payload: { text: "world" },
      }),
    ];

    const { result } = renderHook(() =>
      useTurnViewModels({ events }),
    );

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].userChannelEnvelope).toMatchObject({
      provider: "discord",
      kind: "message",
      externalUserId: "ext-1",
    });
  });

  it("hides streaming state when pending user already has assistant reply", () => {
    const pendingUserMessageId = "pending-1";
    const events: EventRecord[] = [
      {
        _id: pendingUserMessageId,
        timestamp: 1,
        type: "user_message",
        payload: { text: "question" },
      },
      createEvent({
        type: "assistant_message",
        payload: {
          text: "answer",
          userMessageId: pendingUserMessageId,
        },
      }),
    ];

    const { result } = renderHook(() =>
      useTurnViewModels({
        events,
        isStreaming: true,
        streamingText: "typing",
        pendingUserMessageId,
      }),
    );

    expect(result.current.showStreaming).toBe(false);
  });

  it("shows standalone streaming when pending user turn is missing", () => {
    const { result } = renderHook(() =>
      useTurnViewModels({
        events: [],
        isStreaming: true,
        streamingText: "draft",
        pendingUserMessageId: "missing-user-message",
      }),
    );

    expect(result.current.showStreaming).toBe(true);
    expect(result.current.showStandaloneStreaming).toBe(true);
    expect(result.current.processedStreamingText).toBe("draft");
  });
});
