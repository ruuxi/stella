/**
 * Chronological, append-only anchoring for agent lifecycle events
 * (`agent-started` / `agent-progress` / `agent-completed` /
 * `agent-failed` / `agent-canceled`) across a turn's rows.
 *
 * Why this exists: the SQLite grouping (`assembleMessageWindow` /
 * `groupEventsIntoMessages`) attaches a turn's pre-assistant events to
 * the FIRST assistant message once one lands. That rule is fine for
 * tool_request/tool_result (inline artifacts only render on finalized
 * assistant rows, so nothing painted ever moves), but lifecycle events
 * render live cards (background-work receipt, agent-completed card).
 * Under the first-assistant rule a card that painted ABOVE the live
 * streaming text (anchored to the user message because no assistant
 * row was persisted yet) gets re-anchored BELOW the text the moment
 * the streamed segment persists — already-painted rows visibly
 * reorder mid-turn.
 *
 * The rule here is arrival order, applied on the merged display list
 * (persisted messages + streaming overlays):
 *
 *   - Every assistant anchor has a *stream start* time: the overlay's
 *     first-chunk timestamp while streaming, and the persisted row's
 *     `metadata.runtime.streamStartedAtMs` (stamped by the worker at
 *     the segment's first stream chunk) afterwards.
 *   - A lifecycle event anchors to the LATEST anchor in its turn whose
 *     stream start is <= the event's timestamp — i.e. exactly where the
 *     bottom of the transcript was when the event occurred. An event
 *     that predates every assistant's stream start anchors to the
 *     turn's user message (renders above the text, where it first
 *     painted); an event that fires mid-stream anchors to the streaming
 *     segment (renders after the growing text block, never injected
 *     above it).
 *   - Once routed, the decision is STICKY for the session (`sticky`
 *     map, `eventId -> anchorKey`). The overlay and its eventual
 *     persisted twin share the same anchor key, so the overlay ->
 *     persisted handoff cannot move a card even when the renderer- and
 *     worker-observed stream starts differ by a few ms.
 *   - Assistants with no `streamStartedAtMs` (transcripts persisted
 *     before this metadata existed) are left alone: events already
 *     attached to them stay put, preserving old renderings.
 */
import type {
  EventRecord,
  MessageRecord,
} from "../../../../../runtime/contracts/local-chat.js";
import { isUiHiddenChatMessagePayload } from "../../../../../runtime/chat-event-visibility.js";

const LIFECYCLE_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);

const isLifecycleEvent = (event: EventRecord): boolean =>
  LIFECYCLE_EVENT_TYPES.has(event.type);

/** Synthetic `_id` prefix of streaming-overlay rows (see streaming-types). */
const STREAMING_OVERLAY_ID_PREFIX = "stream-overlay:";

export type LifecycleRoutingState = {
  /** Sticky `eventId -> anchorKey` decisions for the session. */
  sticky: Map<string, string>;
  /**
   * Structural-sharing cache: base (unrouted) message object -> the routed
   * object previously produced for it, so unchanged routings reuse the same
   * output identity across stream deltas and downstream memo caches hold.
   */
  routedByBase: WeakMap<MessageRecord, MessageRecord>;
};

export const createLifecycleRoutingState = (): LifecycleRoutingState => ({
  sticky: new Map(),
  routedByBase: new WeakMap(),
});

const getAssistantUserMessageId = (
  message: MessageRecord,
): string | undefined => {
  const payload = message.payload as { userMessageId?: unknown } | undefined;
  return typeof payload?.userMessageId === "string" &&
    payload.userMessageId.length > 0
    ? payload.userMessageId
    : undefined;
};

const getStreamStartedAtMs = (message: MessageRecord): number | undefined => {
  if (message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX)) {
    // Overlay rows sort by (and were created at) their first-chunk time.
    return message.timestamp;
  }
  const metadata = (
    message.payload as
      | { metadata?: { runtime?: { streamStartedAtMs?: unknown } } }
      | undefined
  )?.metadata;
  const value = metadata?.runtime?.streamStartedAtMs;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

type Anchor = {
  key: string;
  /**
   * Stream start for assistant anchors; `-Infinity` for the user-message
   * anchor; `undefined` for legacy assistants (not routing targets, and
   * their attached events stay put).
   */
  startTs: number | undefined;
  messageIndex: number;
};

const compareEvents = (a: EventRecord, b: EventRecord): number =>
  a.timestamp !== b.timestamp
    ? a.timestamp - b.timestamp
    : a._id.localeCompare(b._id);

const sameToolEventIds = (
  a: readonly EventRecord[],
  b: readonly EventRecord[],
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!._id !== b[i]!._id) return false;
  }
  return true;
};

/**
 * Re-anchor lifecycle events across the merged display messages per the
 * arrival-order rule above. Pure aside from the caller-owned `state`
 * (sticky decisions + identity cache). Returns the input array reference
 * when nothing moves.
 */
export const routeLifecycleEvents = (
  messages: MessageRecord[],
  state: LifecycleRoutingState,
): MessageRecord[] => {
  // Fast bail: no lifecycle events anywhere.
  let hasLifecycle = false;
  for (const message of messages) {
    if (message.toolEvents.some(isLifecycleEvent)) {
      hasLifecycle = true;
      break;
    }
  }
  if (!hasLifecycle) return messages;

  // `messageIndex -> final toolEvents` for messages whose events changed.
  const routedEventsByIndex = new Map<number, EventRecord[]>();

  const assistantCountByUserMessageId = new Map<string, number>();

  type TurnEntry = {
    anchor: Anchor;
    message: MessageRecord;
  };
  let turn: TurnEntry[] = [];

  const flushTurn = () => {
    if (turn.length === 0) return;
    const entries = turn;
    turn = [];

    let turnHasLifecycle = false;
    for (const entry of entries) {
      if (entry.message.toolEvents.some(isLifecycleEvent)) {
        turnHasLifecycle = true;
        break;
      }
    }
    if (!turnHasLifecycle) return;

    const anchorsByKey = new Map<string, TurnEntry>();
    for (const entry of entries) anchorsByKey.set(entry.anchor.key, entry);
    // Routing targets: anchors with a defined start, in walk order (their
    // startTs are non-decreasing by construction of the timeline).
    const targets = entries.filter(
      (entry) => entry.anchor.startTs !== undefined,
    );

    const resolveTarget = (
      source: TurnEntry,
      event: EventRecord,
    ): TurnEntry => {
      const stickyKey = state.sticky.get(event._id);
      if (stickyKey !== undefined) {
        const pinned = anchorsByKey.get(stickyKey);
        if (pinned) return pinned;
      }
      // Legacy assistants (no stream-start metadata) keep their events:
      // there is no way to place them chronologically, and moving them
      // would churn transcripts persisted before this rule existed.
      if (source.anchor.startTs === undefined) {
        state.sticky.set(event._id, source.anchor.key);
        return source;
      }
      let resolved: TurnEntry | undefined;
      for (const candidate of targets) {
        const startTs = candidate.anchor.startTs;
        if (startTs !== undefined && startTs <= event.timestamp) {
          resolved = candidate;
        }
      }
      const target = resolved ?? source;
      state.sticky.set(event._id, target.anchor.key);
      return target;
    };

    // Incoming lifecycle events per anchor key (routed from elsewhere).
    const incomingByKey = new Map<string, EventRecord[]>();
    // Event ids that left their source message.
    const movedOut = new Map<TurnEntry, Set<string>>();

    for (const entry of entries) {
      for (const event of entry.message.toolEvents) {
        if (!isLifecycleEvent(event)) continue;
        const target = resolveTarget(entry, event);
        if (target === entry) continue;
        let out = movedOut.get(entry);
        if (!out) movedOut.set(entry, (out = new Set()));
        out.add(event._id);
        let incoming = incomingByKey.get(target.anchor.key);
        if (!incoming) incomingByKey.set(target.anchor.key, (incoming = []));
        incoming.push(event);
      }
    }
    if (movedOut.size === 0) return;

    for (const entry of entries) {
      const out = movedOut.get(entry);
      const incoming = incomingByKey.get(entry.anchor.key);
      if (!out && !incoming) continue;
      // Preserve the original sequence for events that stay, then append
      // routed-in lifecycle events in chronological order — so a message
      // whose events did not move keeps an identical id sequence.
      const kept = out
        ? entry.message.toolEvents.filter((event) => !out.has(event._id))
        : [...entry.message.toolEvents];
      const next = incoming ? [...kept, ...incoming.sort(compareEvents)] : kept;
      if (sameToolEventIds(next, entry.message.toolEvents)) continue;
      routedEventsByIndex.set(entry.anchor.messageIndex, next);
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.type === "user_message") {
      flushTurn();
      turn.push({
        anchor: {
          key: `user:${message._id}`,
          startTs: Number.NEGATIVE_INFINITY,
          messageIndex: index,
        },
        message,
      });
      continue;
    }
    if (message.type !== "assistant_message") continue;
    // Hidden assistants never anchor cards (mirrors the grouping walk);
    // leave them and their (normally empty) toolEvents untouched.
    if (isUiHiddenChatMessagePayload(message.payload ?? null)) continue;
    const userMessageId = getAssistantUserMessageId(message);
    let key: string;
    if (userMessageId !== undefined) {
      const indexInTurn =
        (assistantCountByUserMessageId.get(userMessageId) ?? 0) + 1;
      assistantCountByUserMessageId.set(userMessageId, indexInTurn);
      // Slot key shared by a streaming overlay and its persisted twin
      // (both occupy the same `(userMessageId, indexInTurn)` slot, only
      // one of which is present at a time) so sticky decisions survive
      // the overlay -> persisted handoff.
      key = `slot:${userMessageId}:${indexInTurn}`;
    } else {
      key = `id:${message._id}`;
    }
    turn.push({
      anchor: {
        key,
        startTs: getStreamStartedAtMs(message),
        messageIndex: index,
      },
      message,
    });
  }
  flushTurn();

  if (routedEventsByIndex.size === 0) return messages;

  const result = messages.slice();
  for (const [index, toolEvents] of routedEventsByIndex) {
    const base = messages[index]!;
    const cached = state.routedByBase.get(base);
    if (cached && sameToolEventIds(cached.toolEvents, toolEvents)) {
      result[index] = cached;
      continue;
    }
    const routed: MessageRecord = { ...base, toolEvents };
    state.routedByBase.set(base, routed);
    result[index] = routed;
  }
  return result;
};
