import { describe, expect, it } from "vitest";
import type {
  EventRecord,
  MessageRecord,
} from "../../../runtime/contracts/local-chat";
import {
  createLifecycleRoutingState,
  routeLifecycleEvents,
} from "@/features/chat/lib/route-lifecycle-events";

const event = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? "",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "agent-started",
  ...overrides,
});

const message = (overrides: Partial<MessageRecord>): MessageRecord => ({
  _id: overrides._id ?? "",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "user_message",
  toolEvents: [],
  ...overrides,
});

/** Delegated agent finishing BEFORE the orchestrator's text started. */
const completedBeforeStream = event({
  _id: "c1",
  type: "agent-completed",
  timestamp: 200,
  payload: { agentId: "agent-a" },
});

/** `send_input` follow-up fired WHILE the orchestrator text was streaming. */
const followUpMidStream = event({
  _id: "s1",
  type: "agent-started",
  timestamp: 400,
  payload: { agentId: "agent-a", isFollowUp: true },
});

describe("routeLifecycleEvents", () => {
  it("routes a mid-stream lifecycle event below the streaming text and keeps pre-stream events above it", () => {
    // Rahul's sequence, live: finished card painted first (user anchor),
    // orchestrator text streaming below it (overlay first chunk at t=300),
    // then send_input creates a follow-up card at t=400. The follow-up must
    // land on the overlay row (below the text); the finished card must stay
    // on the user anchor (above the text).
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const overlay = message({
      _id: "stream-overlay:u1:1",
      timestamp: 300,
      type: "assistant_message",
      payload: {
        text: "streaming…",
        userMessageId: "u1",
        metadata: { runtime: { isStreaming: true } },
      },
      toolEvents: [],
    });

    const state = createLifecycleRoutingState();
    const routed = routeLifecycleEvents([user, overlay], state);

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["s1"]);
  });

  it("keeps the same layout across the overlay -> persisted handoff (completed card / streamed text / follow-up card)", () => {
    const state = createLifecycleRoutingState();

    // Phase 1: live streaming (as above).
    const liveUser = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const overlay = message({
      _id: "stream-overlay:u1:1",
      timestamp: 300,
      type: "assistant_message",
      payload: {
        text: "streaming…",
        userMessageId: "u1",
        metadata: { runtime: { isStreaming: true } },
      },
      toolEvents: [],
    });
    routeLifecycleEvents([liveUser, overlay], state);

    // Phase 2: the segment persisted. SQLite's grouping forward-attaches BOTH
    // pending lifecycle events to the first assistant — which, rendered
    // as-is, is exactly the visible shuffle (text jumps to top, finished
    // card drops to the bottom). Routing must restore the painted layout.
    const persistedUser = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [],
    });
    const persistedAssistant = message({
      _id: "assistant-msg-run1-7",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "final text",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 300 } },
      },
      toolEvents: [completedBeforeStream, followUpMidStream],
    });

    const routed = routeLifecycleEvents(
      [persistedUser, persistedAssistant],
      state,
    );

    // Finished card back above the text; follow-up card stays below it.
    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["s1"]);
  });

  it("re-anchors chronologically on a cold load (no sticky state) using streamStartedAtMs", () => {
    // Reload: no session state, only persisted metadata. Same expected
    // layout as what was painted live.
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [],
    });
    const assistant = message({
      _id: "assistant-msg-run1-7",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "final text",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 300 } },
      },
      toolEvents: [completedBeforeStream, followUpMidStream],
    });

    const routed = routeLifecycleEvents(
      [user, assistant],
      createLifecycleRoutingState(),
    );

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["s1"]);
  });

  it("pins a routed event to its first anchor even if timestamps would later disagree", () => {
    const state = createLifecycleRoutingState();
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream],
    });
    // No overlay yet: the completed card paints on the user anchor.
    routeLifecycleEvents([user], state);

    // The persisted assistant later claims an earlier stream start (clock
    // skew across the worker/renderer boundary). The sticky decision wins:
    // the card was painted above the text and must stay there.
    const assistant = message({
      _id: "assistant-msg-run1-7",
      timestamp: 500,
      type: "assistant_message",
      payload: {
        text: "final",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 150 } },
      },
      toolEvents: [completedBeforeStream],
    });
    const routed = routeLifecycleEvents(
      [message({ ...user, toolEvents: [] }), assistant],
      state,
    );

    expect(routed[0]!.toolEvents.map((e) => e._id)).toEqual(["c1"]);
    expect(routed[1]!.toolEvents).toEqual([]);
  });

  it("leaves legacy assistants (no streamStartedAtMs) untouched and preserves identity", () => {
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [],
    });
    const legacyAssistant = message({
      _id: "a1",
      timestamp: 500,
      type: "assistant_message",
      payload: { text: "old transcript", userMessageId: "u1" },
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const input = [user, legacyAssistant];

    const routed = routeLifecycleEvents(input, createLifecycleRoutingState());

    expect(routed).toBe(input);
  });

  it("releases a card born mid-stream the moment the stream ends (persisted twin, no further events)", () => {
    // Rahul's exact sequence: agent finishes WHILE text streams (card held
    // after the streaming block), stream ends and the segment persists —
    // the card must be on the finished text's row immediately, without any
    // subsequent event forcing a re-derive.
    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });

    // Frame 1: streaming; the completion (grouped onto the user anchor)
    // routes to the live overlay row — after the growing text block.
    const liveFrame = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );
    expect(liveFrame[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);

    // Frame 2: stream ended — overlay gone, twin persisted (event
    // forward-attached by the grouping). No other events arrived.
    const settled = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: {
            text: "final text",
            userMessageId: "u1",
            metadata: { runtime: { streamStartedAtMs: 300 } },
          },
          toolEvents: [midStreamCompleted],
        }),
      ],
      state,
    );
    // Same slot as the overlay row it was displayed after — card visible
    // on the finished text's row, immediately.
    expect(settled[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(settled[0]!.toolEvents).toEqual([]);
  });

  it("releases a card immediately when the overlay vanishes WITHOUT a persisted twin (aborted segment)", () => {
    // Overlay-slot routings are per-frame, never sticky: if the segment
    // aborts (canceled run / empty text) and no twin ever lands, the very
    // next derive re-homes the event onto the surviving anchors instead of
    // leaving it parked on a dead slot until some later event.
    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });
    const userWithEvent = () =>
      message({
        _id: "u1",
        timestamp: 100,
        type: "user_message",
        toolEvents: [midStreamCompleted],
      });

    const liveFrame = routeLifecycleEvents(
      [
        userWithEvent(),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );
    expect(liveFrame[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);

    // Overlay cleared, nothing persisted for the slot.
    const released = routeLifecycleEvents([userWithEvent()], state);
    expect(released[0]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
  });

  it("keeps a mid-stream card on the twin's row when the twin lacks streamStartedAtMs (legacy worker)", () => {
    const state = createLifecycleRoutingState();
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });

    routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "stream-overlay:u1:1",
          timestamp: 300,
          type: "assistant_message",
          payload: {
            text: "streaming…",
            userMessageId: "u1",
            metadata: { runtime: { isStreaming: true } },
          },
          toolEvents: [],
        }),
      ],
      state,
    );

    // Twin persisted WITHOUT metadata (legacy). It occupies the same slot
    // the overlay rendered in, so the card must stay on that row.
    const settled = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: { text: "final text", userMessageId: "u1" },
          toolEvents: [midStreamCompleted],
        }),
      ],
      state,
    );
    expect(settled[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
    expect(settled[0]!.toolEvents).toEqual([]);
  });

  it("collapses a tail-refresh duplicate (stale user copy + assistant copy) onto one anchor", () => {
    // The tail refresh replaces only changed rows, so after the segment
    // persists, the stale user row can still carry the event the grouping
    // moved onto the assistant. One event id must resolve to ONE anchor
    // with ONE copy — never a doubled toolEvents list.
    const midStreamCompleted = event({
      _id: "c-mid",
      type: "agent-completed",
      timestamp: 350,
      payload: { agentId: "agent-a" },
    });
    const routed = routeLifecycleEvents(
      [
        message({
          _id: "u1",
          timestamp: 100,
          type: "user_message",
          toolEvents: [midStreamCompleted],
        }),
        message({
          _id: "assistant-msg-run1-9",
          timestamp: 400,
          type: "assistant_message",
          payload: {
            text: "final text",
            userMessageId: "u1",
            metadata: { runtime: { streamStartedAtMs: 300 } },
          },
          toolEvents: [midStreamCompleted],
        }),
      ],
      createLifecycleRoutingState(),
    );
    expect(routed[0]!.toolEvents).toEqual([]);
    expect(routed[1]!.toolEvents.map((e) => e._id)).toEqual(["c-mid"]);
  });

  it("reuses routed message identity across repeated calls (structural sharing)", () => {
    const state = createLifecycleRoutingState();
    const user = message({
      _id: "u1",
      timestamp: 100,
      type: "user_message",
      toolEvents: [completedBeforeStream, followUpMidStream],
    });
    const overlay = () =>
      message({
        _id: "stream-overlay:u1:1",
        timestamp: 300,
        type: "assistant_message",
        payload: {
          text: "streaming…",
          userMessageId: "u1",
          metadata: { runtime: { isStreaming: true } },
        },
        toolEvents: [],
      });

    const first = routeLifecycleEvents([user, overlay()], state);
    const second = routeLifecycleEvents([user, overlay()], state);

    // The re-routed user message keeps one identity across stream deltas so
    // downstream memo caches hold.
    expect(second[0]).toBe(first[0]);
  });
});
