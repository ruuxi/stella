/**
 * Chronological, append-only anchoring for agent lifecycle events
 * (`agent-started` / `agent-progress` / `agent-completed` /
 * `agent-failed` / `agent-canceled`) across a turn's rows.
 *
 * Why this exists: the SQLite grouping (`assembleMessageWindow` /
 * `groupEventsIntoMessages`) attaches a turn's pre-assistant events to
 * the FIRST assistant message once one lands. That rule is fine for
 * tool_request/tool_result (inline artifacts only render on finalized
 * assistant rows, so nothing painted ever moves), but `agent-started`
 * renders a live background-work card. Later lifecycle packets are still
 * routed/deduplicated here, then the task selector folds them back onto that
 * start-anchored card.
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
 *     worker-observed stream starts differ by a few ms, or when the
 *     overlay is cleared a frame before the twin loads. A pin whose
 *     anchor is absent from the current window is KEPT (the anchor may
 *     come back) while the event renders at a per-frame fallback — which
 *     is also the stream-end release for aborted segments that never
 *     persist a twin: their slot key never returns, so the event settles
 *     on the surviving anchors. A pin hit by a LATER overlay reusing the
 *     slot of an aborted segment is detected (its stream start postdates
 *     the event) and dropped as stale.
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

    // One routing decision per EVENT ID. The SQLite/tail-refresh handoff
    // can briefly leave the same lifecycle event on two rows (the stale
    // pre-assistant copy on the user anchor plus the fresh copy the
    // grouping forward-attached to the assistant); resolving per id
    // collapses those duplicates onto a single target so the card can
    // never render twice (or produce a doubled toolEvents list). The
    // LAST source in walk order is the canonical one — for a duplicate
    // it is the anchor the grouping most recently attached the event to,
    // while the earlier copy is the stale leftover.
    const sourcesByEventId = new Map<
      string,
      { event: EventRecord; lastSource: TurnEntry }
    >();
    // Entries whose toolEvents may change (lose a duplicate/moved copy or
    // gain a routed-in event). Everything else skips the rebuild below —
    // this runs per stream chunk, so untouched rows must stay allocation
    // free.
    const changed = new Set<TurnEntry>();
    for (const entry of entries) {
      for (const event of entry.message.toolEvents) {
        if (!isLifecycleEvent(event)) continue;
        const existing = sourcesByEventId.get(event._id);
        if (existing) {
          // Duplicate copy: at most one of the involved rows keeps it.
          changed.add(existing.lastSource);
          changed.add(entry);
          existing.lastSource = entry;
        } else {
          sourcesByEventId.set(event._id, { event, lastSource: entry });
        }
      }
    }
    if (sourcesByEventId.size === 0) return;

    const anchorsByKey = new Map<string, TurnEntry>();
    for (const entry of entries) anchorsByKey.set(entry.anchor.key, entry);
    // Routing targets: anchors with a defined start, in walk order (their
    // startTs are non-decreasing by construction of the timeline).
    const targets = entries.filter(
      (entry) => entry.anchor.startTs !== undefined,
    );

    const isOverlayEntry = (entry: TurnEntry): boolean =>
      entry.message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX);

    const resolveTarget = (
      source: TurnEntry,
      event: EventRecord,
    ): TurnEntry => {
      let stickyKey = state.sticky.get(event._id);
      if (stickyKey !== undefined) {
        const pinned = anchorsByKey.get(stickyKey);
        if (pinned) {
          // A pin is only ever recorded while its anchor's stream start
          // was <= the event's timestamp, and a persisted twin keeps
          // (roughly) its overlay's start. So an OVERLAY occupying the
          // pinned slot with a LATER start is a different, newer stream
          // reusing the slot of an aborted segment — the pin is stale and
          // must not capture the new run's row.
          const pinnedStart = pinned.anchor.startTs;
          const stale =
            isOverlayEntry(pinned) &&
            pinnedStart !== undefined &&
            pinnedStart > event.timestamp;
          if (!stale) return pinned;
          state.sticky.delete(event._id);
          stickyKey = undefined;
        }
        // The pinned anchor is not in this window (trimmed / the one-frame
        // overlay -> twin handoff gap / an aborted segment whose twin never
        // lands). Fall back to a per-frame computation but KEEP the pin —
        // the anchor may come back, and stomping it here is what let a
        // transient frame permanently re-home a painted card. If it never
        // comes back (abort), the per-frame fallback IS the release.
      }
      // Legacy assistants (no stream-start metadata) keep their events:
      // there is no way to place them chronologically, and moving them
      // would churn transcripts persisted before this rule existed.
      if (source.anchor.startTs === undefined) {
        if (stickyKey === undefined) {
          state.sticky.set(event._id, source.anchor.key);
        }
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
      // Pin overlay routings too: the overlay and its persisted twin share
      // one slot key, so the pin survives the handoff even when the twin's
      // worker-stamped stream start lands a few ms AFTER the event (clock
      // skew would otherwise exclude it from `targets` and yank the card
      // above the text), or when the overlay is cleared a frame before the
      // twin loads.
      if (stickyKey === undefined) {
        state.sticky.set(event._id, target.anchor.key);
      }
      return target;
    };

    const targetByEventId = new Map<string, TurnEntry>();
    for (const [eventId, { event, lastSource }] of sourcesByEventId) {
      targetByEventId.set(eventId, resolveTarget(lastSource, event));
    }

    // Incoming lifecycle events per anchor key (routed from elsewhere),
    // and the set of ids each target already carries (so a routed-in copy
    // is added at most once and prefers the copy already on the target).
    const incomingByKey = new Map<string, EventRecord[]>();
    const placedIds = new Set<string>();
    for (const [eventId, target] of targetByEventId) {
      if (
        target.message.toolEvents.some(
          (event) => event._id === eventId && isLifecycleEvent(event),
        )
      ) {
        placedIds.add(eventId);
      }
    }
    for (const entry of entries) {
      for (const event of entry.message.toolEvents) {
        if (!isLifecycleEvent(event)) continue;
        const target = targetByEventId.get(event._id);
        if (!target || target === entry) continue;
        changed.add(entry); // loses this copy
        if (placedIds.has(event._id)) continue;
        placedIds.add(event._id);
        changed.add(target); // gains the routed-in copy
        let incoming = incomingByKey.get(target.anchor.key);
        if (!incoming) incomingByKey.set(target.anchor.key, (incoming = []));
        incoming.push(event);
      }
    }

    for (const entry of entries) {
      if (!changed.has(entry)) continue;
      const incoming = incomingByKey.get(entry.anchor.key);
      // Keep events that stay on this anchor, dropping moved-away copies
      // and any duplicate occurrences beyond the first, then append
      // routed-in lifecycle events in chronological order — so a message
      // whose events did not move keeps an identical id sequence.
      const seenHere = new Set<string>();
      const kept = entry.message.toolEvents.filter((event) => {
        if (!isLifecycleEvent(event)) return true;
        if (targetByEventId.get(event._id) !== entry) return false;
        if (seenHere.has(event._id)) return false;
        seenHere.add(event._id);
        return true;
      });
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
