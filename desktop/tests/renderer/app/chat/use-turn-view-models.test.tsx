import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import { useTurnViewModels } from "../../../../src/app/chat/use-turn-view-models";

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
    const sourceTimestamp = Date.UTC(2026, 2, 8, 20, 0, 0);
    const events: EventRecord[] = [
      {
        _id: userId,
        timestamp: 1,
        type: "user_message",
        payload: { text: "[8:00 PM] hello\n\n[1:00 PM, Mar 8]" },
        channelEnvelope: {
          provider: "discord",
          kind: "message",
          externalUserId: "ext-1",
          sourceTimestamp,
        },
      },
      createEvent({
        type: "assistant_message",
        payload: {
          text: "[8:05 PM] world\n\n[1:05 PM, Mar 8]",
          source: "channel:discord",
        },
        channelEnvelope: {
          provider: "discord",
          kind: "message",
          sourceTimestamp: Date.UTC(2026, 2, 8, 20, 5, 0),
        },
      }),
    ];

    const { result } = renderHook(() =>
      useTurnViewModels({ events }),
    );

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].userText).toBe("hello");
    expect(result.current.turns[0].userChannelEnvelope).toMatchObject({
      provider: "discord",
      kind: "message",
      externalUserId: "ext-1",
    });
    expect(result.current.turns[0].assistantText).toBe("world");
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

  it("attaches WebSearch HTML to the turn view model for badge rendering", () => {
    const events: EventRecord[] = [
      {
        _id: "user-1",
        timestamp: 1,
        type: "user_message",
        payload: { text: "what's happening?" },
      },
      {
        _id: "tool-1",
        timestamp: 2,
        type: "tool_result",
        payload: {
          toolName: "WebSearch",
          html: "<section><h3>Top story</h3></section>",
          result: "<section><h3>Top story</h3></section>",
        },
      },
      {
        _id: "assistant-1",
        timestamp: 3,
        type: "assistant_message",
        payload: { text: "Here's the briefing." },
      },
    ];

    const { result } = renderHook(() =>
      useTurnViewModels({ events }),
    );

    expect(result.current.turns[0].webSearchBadgeHtml).toBe(
      "<section><h3>Top story</h3></section>",
    );
  });
});

