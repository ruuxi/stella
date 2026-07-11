import { describe, expect, it } from "vitest";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
import {
  findOverlayWinnerIndices,
  getPersistedAssistantSlots,
  keepAssistantTurnsContiguous,
  mergeConversationDisplayMessageSources,
  overlayMergeShapeUnchanged,
  overlayToMessageRecord,
  rebuildDisplayMessagesFromCachedOrder,
} from "@/features/chat/hooks/use-conversation-display-messages";

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

  it("deduplicates a live assistant against its exact canonical row even if slot indexing drifted", () => {
    const canonical = message({
      _id: "assistant-msg-run-1-10",
      timestamp: 30,
      payload: { text: "same reply", userMessageId: "u1" },
    });
    const live = overlay({
      // A replayed boundary used to advance this to the wrong ordinal.
      _id: "stream-overlay:u1:2",
      indexInTurn: 2,
      text: "same reply",
      canonicalMessageId: canonical._id,
      locked: true,
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [
        message({ _id: "u1", type: "user_message", timestamp: 1 }),
        canonical,
      ],
      overlayMessages: [overlayToMessageRecord(live, canonical)],
      streamingAssistants: [live],
      persistedAssistantSlots: getPersistedAssistantSlots([canonical]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "u1",
      "stream-overlay:u1:2",
    ]);
    expect(merged.filter((item) => item.payload?.text === "same reply")).toHaveLength(1);
  });

  it("keeps a queued user send after an assistant that was visible first on cold load", () => {
    const assistant = message({
      _id: "assistant-before-queue",
      // Persistence completed after the queued send.
      timestamp: 400,
      payload: {
        text: "earlier visible reply",
        userMessageId: "u1",
        metadata: { runtime: { streamStartedAtMs: 100 } },
      },
    });
    const queuedUser = message({
      _id: "queued-user",
      type: "user_message",
      timestamp: 200,
      payload: { text: "you don't need to trace" },
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [queuedUser, assistant],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([assistant]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "assistant-before-queue",
      "queued-user",
    ]);
  });

  it("does not let a drained queued user split preamble and post-tool assistant slots", () => {
    const activeUser = message({
      _id: "u1",
      type: "user_message",
      timestamp: 50,
    });
    const preamble = message({
      _id: "assistant-preamble",
      timestamp: 100,
      payload: { text: "I will check.", userMessageId: "u1" },
    });
    const drainedQueuedUser = message({
      _id: "u2",
      type: "user_message",
      // The click happened while u1 was running.
      timestamp: 200,
      payload: { text: "follow up" },
    });
    const postToolAnswer = message({
      _id: "assistant-post-tool",
      // This slot first streamed after the queued click.
      timestamp: 300,
      payload: { text: "Done.", userMessageId: "u1" },
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [
        activeUser,
        preamble,
        drainedQueuedUser,
        postToolAnswer,
      ],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([
        preamble,
        postToolAnswer,
      ]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "u1",
      "assistant-preamble",
      "assistant-post-tool",
      "u2",
    ]);
  });

  it("places a dequeued user below every assistant that completed while it waited", () => {
    const activeUser = message({
      _id: "u1",
      type: "user_message",
      timestamp: 50,
    });
    const correction = message({
      _id: "assistant-correction",
      timestamp: 200,
      payload: {
        text: "Sent the correction.",
        userMessageId: "u1",
      },
    });
    const review = message({
      _id: "assistant-review",
      timestamp: 300,
      payload: {
        text: "Self-mod round-3 review running.",
        userMessageId: "u1",
      },
    });
    const dequeuedUser = message({
      _id: "u2",
      type: "user_message",
      // Enqueued at 150, but officially dequeued after both prior replies.
      timestamp: 400,
      payload: { text: "Nevermind, let it publish." },
    });
    const ownResponse = message({
      _id: "assistant-for-u2",
      timestamp: 500,
      payload: {
        text: "No worries — letting it publish.",
        userMessageId: "u2",
      },
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [
        activeUser,
        correction,
        review,
        dequeuedUser,
        ownResponse,
      ],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([
        correction,
        review,
        ownResponse,
      ]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "u1",
      "assistant-correction",
      "assistant-review",
      "u2",
      "assistant-for-u2",
    ]);
  });

  it("keeps a same-millisecond assistant response after its owning user", () => {
    const user = message({
      _id: "z-user",
      type: "user_message",
      timestamp: 400,
    });
    const response = message({
      _id: "a-assistant",
      timestamp: 400,
      payload: { text: "response", userMessageId: "z-user" },
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [response, user],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([response]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "z-user",
      "a-assistant",
    ]);
  });

  it("keeps a backward-clock assistant response after its owning user", () => {
    const user = message({
      _id: "u-backward",
      type: "user_message",
      timestamp: 800,
    });
    const response = message({
      _id: "assistant-backward",
      timestamp: 700,
      payload: {
        text: "response after clock regression",
        userMessageId: "u-backward",
        metadata: { runtime: { streamStartedAtMs: 650 } },
      },
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [response, user],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([response]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "u-backward",
      "assistant-backward",
    ]);
  });

  it("preserves same-turn assistant segment ordinals when clamped anchors tie", () => {
    const user = message({
      _id: "u-segments",
      type: "user_message",
      timestamp: 1_000,
    });
    const preamble = message({
      _id: "assistant-msg-run-2",
      timestamp: 800,
      payload: {
        text: "preamble",
        userMessageId: "u-segments",
        metadata: { runtime: { streamStartedAtMs: 700 } },
      },
    });
    const postTool = message({
      _id: "assistant-msg-run-10",
      timestamp: 900,
      payload: {
        text: "post-tool answer",
        userMessageId: "u-segments",
        metadata: { runtime: { streamStartedAtMs: 750 } },
      },
    });
    const nextUser = message({
      _id: "u-next",
      type: "user_message",
      timestamp: 1_002,
    });

    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [user, preamble, postTool, nextUser],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([
        preamble,
        postTool,
      ]),
    });

    expect(merged.map((item) => item._id)).toEqual([
      "u-segments",
      "assistant-msg-run-2",
      "assistant-msg-run-10",
      "u-next",
    ]);
  });

  it("keeps user-response ordering stable across optimistic to canonical handoff", () => {
    const optimisticUser = message({
      _id: "u-handoff",
      type: "user_message",
      timestamp: 900,
    });
    const live = overlay({
      _id: "stream-overlay:u-handoff:1",
      userMessageId: "u-handoff",
      timestamp: 900,
      runId: "run-handoff",
    });
    const liveMessage = overlayToMessageRecord(live);
    const liveMerged = mergeConversationDisplayMessageSources({
      persistedMessages: [],
      overlayMessages: [optimisticUser, liveMessage],
      streamingAssistants: [live],
      persistedAssistantSlots: new Map(),
    });

    const canonicalUser = message({
      _id: "u-handoff",
      type: "user_message",
      timestamp: 900,
      payload: { text: "persisted user" },
    });
    const canonicalResponse = message({
      _id: "assistant-handoff",
      timestamp: 950,
      payload: {
        text: "canonical response",
        userMessageId: "u-handoff",
        metadata: { runtime: { streamStartedAtMs: 900 } },
      },
    });
    const canonicalMerged = mergeConversationDisplayMessageSources({
      persistedMessages: [canonicalUser, canonicalResponse],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([
        canonicalResponse,
      ]),
    });

    expect(optimisticUser).not.toBe(canonicalUser);
    expect(canonicalUser.timestamp).toBe(optimisticUser.timestamp);
    expect(liveMerged.map((item) => [item._id, item.timestamp])).toEqual([
      ["u-handoff", 900],
      ["stream-overlay:u-handoff:1", 900],
    ]);
    expect(
      canonicalMerged.map((item) => [item._id, item.timestamp]),
    ).toEqual([
      ["u-handoff", 900],
      ["assistant-handoff", 950],
    ]);
  });

  it("does not move a non-user-turn assistant notice across a later user", () => {
    const messages = [
      message({ _id: "u1", type: "user_message", timestamp: 1 }),
      message({ _id: "u2", type: "user_message", timestamp: 2 }),
      message({
        _id: "terminal-notice",
        timestamp: 3,
        payload: {
          userMessageId: "u1",
          metadata: {
            runtime: { responseTarget: { type: "agent_terminal_notice" } },
          },
        },
      }),
    ];

    expect(keepAssistantTurnsContiguous(messages)).toBe(messages);
  });
});

describe("conversation display merge — structural-sharing fast path", () => {
  // Build the inputs for a turn that is mid-stream: a user message, a prior
  // assistant turn, and a live overlay masking its persisted twin.
  const buildScene = (overlayText: string) => {
    const user = message({ _id: "u1", type: "user_message", timestamp: 0 });
    const priorAssistant = message({
      _id: "assistant-msg-prior",
      timestamp: 1,
      payload: { text: "earlier reply", userMessageId: "u0" },
    });
    const persistedTwin = message({
      _id: "assistant-msg-run-1-10",
      timestamp: 3,
      payload: { text: "stored text", userMessageId: "u1" },
    });
    const persistedMessages = [user, priorAssistant, persistedTwin];
    const live = overlay({ text: overlayText, timestamp: 2 });
    const overlayMessages = [overlayToMessageRecord(live, persistedTwin)];
    const persistedAssistantSlots = getPersistedAssistantSlots([
      priorAssistant,
      persistedTwin,
    ]);
    return {
      persistedMessages,
      overlayMessages,
      streamingAssistants: [live],
      persistedAssistantSlots,
    };
  };

  it("reuse equals a full recompute when only overlay text grows", () => {
    const first = buildScene("strea");
    const fullFirst = mergeConversationDisplayMessageSources(first);
    const winners = findOverlayWinnerIndices(fullFirst, first.overlayMessages);

    // Next delta: identical persisted set + slot index (stable refs), overlay
    // rebuilt with grown text (new object, same id/timestamp/type).
    const second = {
      ...first,
      overlayMessages: [
        overlayToMessageRecord(
          overlay({ text: "streamed text", timestamp: 2 }),
          first.persistedMessages[2]!,
        ),
      ],
    };

    expect(
      overlayMergeShapeUnchanged(first.overlayMessages, second.overlayMessages),
    ).toBe(true);

    const reused = rebuildDisplayMessagesFromCachedOrder(
      fullFirst,
      winners,
      second.overlayMessages,
    );
    const fullSecond = mergeConversationDisplayMessageSources({
      ...second,
      persistedMessages: first.persistedMessages,
      persistedAssistantSlots: first.persistedAssistantSlots,
    });

    expect(reused).not.toBeNull();
    // Identical ordering + membership.
    expect(reused!.map((m) => m._id)).toEqual(fullSecond.map((m) => m._id));
    // Identical masking + timestamp ordering: user (ts 0), prior assistant
    // (ts 1), live overlay (ts 2); the persisted twin (ts 3) stays hidden.
    expect(reused!.map((m) => m._id)).toEqual([
      "u1",
      "assistant-msg-prior",
      "stream-overlay:u1:1",
    ]);
    // The overlay slot reflects the grown text...
    const reusedOverlay = reused!.find((m) => m._id === "stream-overlay:u1:1");
    expect(reusedOverlay!.payload?.text).toBe("streamed text");
    // ...and matches the full recompute's object at that slot by reference.
    const fullOverlay = fullSecond.find((m) => m._id === "stream-overlay:u1:1");
    expect(reusedOverlay).toBe(second.overlayMessages[0]);
    expect(reusedOverlay).toBe(fullOverlay);
    // Persisted-winner positions reuse the cached (stable) objects.
    const reusedUser = reused!.find((m) => m._id === "u1");
    expect(reusedUser).toBe(first.persistedMessages[0]);
  });

  it("only the overlay positions are swapped; persisted refs are preserved", () => {
    const scene = buildScene("hello");
    const full = mergeConversationDisplayMessageSources(scene);
    const winners = findOverlayWinnerIndices(full, scene.overlayMessages);
    // Exactly one overlay winner (the streaming overlay); the two persisted
    // rows are not winners.
    expect(winners).toHaveLength(1);
    expect(full[winners[0]!]!._id).toBe("stream-overlay:u1:1");
  });

  it("shape check fails when membership/order/timestamp actually changes", () => {
    const base = buildScene("hi").overlayMessages;
    // Different id (new slot).
    expect(
      overlayMergeShapeUnchanged(base, [
        overlayToMessageRecord(
          overlay({ _id: "stream-overlay:u1:2", indexInTurn: 2 }),
          undefined,
        ),
      ]),
    ).toBe(false);
    // Different length.
    expect(overlayMergeShapeUnchanged(base, [])).toBe(false);
    // Different timestamp (would reorder the sort).
    expect(
      overlayMergeShapeUnchanged(base, [
        overlayToMessageRecord(overlay({ text: "hi", timestamp: 99 }), undefined),
      ]),
    ).toBe(false);
  });

  it("falls back (returns null) if an overlay-winner id is missing", () => {
    const scene = buildScene("x");
    const full = mergeConversationDisplayMessageSources(scene);
    const winners = findOverlayWinnerIndices(full, scene.overlayMessages);
    // Current overlay list no longer contains the winner id → caller must
    // recompute rather than reuse a stale order.
    expect(
      rebuildDisplayMessagesFromCachedOrder(full, winners, []),
    ).toBeNull();
  });

  it("merges an already-ordered union into the same order as a full sort (skip path)", () => {
    // Persisted already in (timestamp, _id) order; overlay is the newest →
    // the deduped union is already sorted, so the merge skips the sort. Result
    // must still be exactly the display order.
    const persistedMessages = [
      message({ _id: "u1", type: "user_message", timestamp: 0 }),
      message({ _id: "a1", timestamp: 1 }),
      message({ _id: "u2", type: "user_message", timestamp: 2 }),
    ];
    const overlayMessages = [
      message({ _id: "u3", type: "user_message", timestamp: 3 }),
    ];
    const merged = mergeConversationDisplayMessageSources({
      persistedMessages,
      overlayMessages,
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots(persistedMessages),
    });
    expect(merged.map((m) => m._id)).toEqual(["u1", "a1", "u2", "u3"]);
  });

  it("fully sorts a union that arrives out of order (sort path)", () => {
    // Overlay timestamp lands BEFORE a persisted message → adjacency scan finds
    // an inversion and the full sort runs, producing correct display order.
    const persistedMessages = [
      message({ _id: "u1", type: "user_message", timestamp: 0 }),
      message({ _id: "a3", timestamp: 3 }),
    ];
    const overlayMessages = [
      message({ _id: "a1", timestamp: 1 }),
      message({ _id: "a2", timestamp: 2 }),
    ];
    const merged = mergeConversationDisplayMessageSources({
      persistedMessages,
      overlayMessages,
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots(persistedMessages),
    });
    expect(merged.map((m) => m._id)).toEqual(["u1", "a1", "a2", "a3"]);
  });

  it("breaks equal timestamps by _id and dedups first-wins (persisted over overlay)", () => {
    const persistedWinner = message({ _id: "dup", timestamp: 5 });
    const persistedMessages = [
      message({ _id: "b", timestamp: 5 }),
      persistedWinner,
      message({ _id: "a", timestamp: 5 }),
    ];
    const overlayMessages = [
      // Same id as a persisted message → persisted must win (listed first).
      message({ _id: "dup", timestamp: 5, payload: { text: "overlay" } }),
      message({ _id: "c", timestamp: 5 }),
    ];
    const merged = mergeConversationDisplayMessageSources({
      persistedMessages,
      overlayMessages,
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots(persistedMessages),
    });
    // Equal timestamps → ordered by _id; "dup" resolves to the persisted obj.
    expect(merged.map((m) => m._id)).toEqual(["a", "b", "c", "dup"]);
    expect(merged.find((m) => m._id === "dup")).toBe(persistedWinner);
  });

  it("reuses the array as-is when no overlay contributed (empty winners)", () => {
    const persistedMessages = [
      message({ _id: "u1", type: "user_message", timestamp: 0 }),
    ];
    const cachedResult = mergeConversationDisplayMessageSources({
      persistedMessages,
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots(persistedMessages),
    });
    expect(rebuildDisplayMessagesFromCachedOrder(cachedResult, [], [])).toBe(
      cachedResult,
    );
  });
});

describe("stable slot ordering across the overlay -> persisted handoff", () => {
  // Reproduces the agent/artifact-card reorder: an assistant turn's card
  // sorts by the overlay's `Date.now()` (message START) while streaming, then
  // by the runtime `message.timestamp` (message END) once persisted. A
  // neighbor whose timestamp lands between the two makes the card cross it on
  // handoff. A frozen per-slot resolver pins the persisted twin to the
  // position its overlay first held.
  const user = message({ _id: "u1", type: "user_message", timestamp: 10 });
  // A concurrent producer's row (e.g. scheduled/heartbeat turn) that landed
  // WHILE the card turn was still streaming — its runtime timestamp (25) sits
  // between the overlay's first-chunk time (20) and the persisted twin's
  // message-end time (40).
  const neighbor = message({
    _id: "assistant-neighbor",
    timestamp: 25,
    payload: { text: "concurrent turn", userMessageId: "u-other" },
  });
  const persistedTwin = message({
    _id: "assistant-msg-run-1-10",
    timestamp: 40,
    payload: { text: "I started the agent", userMessageId: "u1" },
  });
  const live = overlay({ userMessageId: "u1", indexInTurn: 1, timestamp: 20 });

  it("streaming phase: overlay card renders above the concurrent neighbor", () => {
    const merged = mergeConversationDisplayMessageSources({
      // Twin already persisted (masked) but overlay still owns the slot.
      persistedMessages: [user, neighbor, persistedTwin],
      overlayMessages: [overlayToMessageRecord(live, persistedTwin)],
      streamingAssistants: [live],
      persistedAssistantSlots: getPersistedAssistantSlots([persistedTwin]),
    });
    expect(merged.map((m) => m._id)).toEqual([
      "u1",
      "stream-overlay:u1:1",
      "assistant-neighbor",
    ]);
  });

  it("finalized WITHOUT the resolver: the card hops below the neighbor (the bug)", () => {
    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [user, neighbor, persistedTwin],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([persistedTwin]),
    });
    // Twin's own timestamp (40) sorts it AFTER the neighbor (25): reorder.
    expect(merged.map((m) => m._id)).toEqual([
      "u1",
      "assistant-neighbor",
      "assistant-msg-run-1-10",
    ]);
  });

  it("finalized WITH the frozen resolver: the card holds its position", () => {
    // Frozen slot ts captured from the overlay (20) — the position the card
    // first rendered at.
    const getSortTimestamp = (m: MessageRecord): number =>
      m._id === persistedTwin._id ? 20 : m.timestamp;
    const merged = mergeConversationDisplayMessageSources({
      persistedMessages: [user, neighbor, persistedTwin],
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots([persistedTwin]),
      getSortTimestamp,
    });
    // Twin holds the overlay's slot (20 < 25), so the card stays above the
    // neighbor exactly where it first appeared.
    expect(merged.map((m) => m._id)).toEqual([
      "u1",
      "assistant-msg-run-1-10",
      "assistant-neighbor",
    ]);
  });
});
