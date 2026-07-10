/**
 * Composes the visible chat timeline from four sources:
 *
 *   - `persistedMessages` — SQLite-backed messages from
 *     `useConversationMessages` (each carries its turn's tool events
 *     pre-grouped on `toolEvents`).
 *   - `optimisticEvents` — fresh user messages emitted by
 *     `useStreamingChat` before the runtime persists them.
 *   - scheduled events — cron / heartbeat user messages still pending
 *     in the scheduler.
 *   - `streamingAssistants` — in-memory assistant messages currently
 *     being streamed from the runtime. Per Option A (standard chat-UI
 *     pattern, c.f. Vercel `useChat`), live stream content is just a
 *     regular assistant row whose text grows over time, NOT a
 *     separate "tail" overlay layered on top of the persisted list. If
 *     SQLite catches up while the live row is still present, the live
 *     row keeps ownership of the visible text and borrows persisted
 *     metadata/tool events from the matching `(userMessageId,
 *     indexInTurn)` slot.
 *
 * Optimistic / scheduled overlays are projected to `MessageRecord[]`
 * via `groupEventsIntoMessages`; streaming overlays are already in
 * `MessageRecord` shape. All four merge into one shape and sort by
 * timestamp + id. For active streamed assistant slots, the live row
 * masks its persisted twin so completion does not swap the rendered
 * message source just because SQLite acknowledged the final text.
 *
 * Kept separate from `useConversationMessages` because the overlay
 * needs `optimisticEvents` / `streamingAssistants` from
 * `useStreamingChat`, which in turn needs `persistedMessages` from
 * `useConversationMessages` — a single hook owning all of that would
 * create a dependency loop.
 */
import { useMemo, useRef } from "react";
import { useScheduledEvents } from "@/features/chat/hooks/use-scheduled-events";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import { groupEventsIntoMessages } from "@/features/chat/lib/group-events-into-messages";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
import {
  createLifecycleRoutingState,
  routeLifecycleEvents,
  type LifecycleRoutingState,
} from "@/features/chat/lib/route-lifecycle-events";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";

const SCHEDULED_EVENTS_OVERLAY_MAX = 200;

type UseConversationDisplayMessagesOptions = {
  conversationId: string | null;
  persistedMessages: MessageRecord[];
  optimisticEvents: EventRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
};

/**
 * Resolves the timestamp a message sorts by. Defaults to the message's own
 * `timestamp`, but the hook overrides it for assistant slots seen live this
 * session so the streaming overlay and its eventual persisted twin sort to
 * the SAME position — see `useConversationDisplayMessages` for why the raw
 * timestamps differ across that handoff and cause card reorders.
 */
export type SortTimestampResolver = (message: MessageRecord) => number;

export const getMessageChronologicalTimestamp: SortTimestampResolver = (
  message,
) => {
  if (message.type === "assistant_message") {
    const payload = message.payload as
      | { metadata?: { runtime?: { streamStartedAtMs?: unknown } } }
      | undefined;
    const streamStartedAtMs = payload?.metadata?.runtime?.streamStartedAtMs;
    if (
      typeof streamStartedAtMs === "number" &&
      Number.isFinite(streamStartedAtMs)
    ) {
      return streamStartedAtMs;
    }
  }
  return message.timestamp;
};

const defaultSortTimestamp: SortTimestampResolver =
  getMessageChronologicalTimestamp;

const compareDisplayOrder = (
  a: MessageRecord,
  b: MessageRecord,
  getSortTimestamp: SortTimestampResolver = defaultSortTimestamp,
): number => {
  const ta = getSortTimestamp(a);
  const tb = getSortTimestamp(b);
  if (ta !== tb) return ta - tb;
  return a._id.localeCompare(b._id);
};

/**
 * Returns `messages` ordered by `getSortTimestamp`, reusing the input array
 * reference when it is already ordered (the common case — the SQLite window is
 * pre-sorted and, with the default resolver, needs no work). Only allocates a
 * sorted copy when the resolver actually reorders something.
 */
const orderByResolver = (
  messages: MessageRecord[],
  getSortTimestamp: SortTimestampResolver,
): MessageRecord[] => {
  for (let i = 1; i < messages.length; i += 1) {
    if (compareDisplayOrder(messages[i - 1]!, messages[i]!, getSortTimestamp) > 0) {
      const copy = messages.slice();
      copy.sort((a, b) => compareDisplayOrder(a, b, getSortTimestamp));
      return copy;
    }
  }
  return messages;
};

const mergeMessageSources = (
  getSortTimestamp: SortTimestampResolver,
  ...sources: MessageRecord[][]
): MessageRecord[] => {
  const seen = new Map<string, MessageRecord>();
  for (const source of sources) {
    for (const message of source) {
      if (!seen.has(message._id)) {
        seen.set(message._id, message);
      }
    }
  }
  const merged = [...seen.values()];
  // The dedup above preserves source + insertion order: persisted messages
  // first (already in their ordered SQLite-window order), then overlays. In
  // the common case — a freshly sent/streamed message carrying the newest
  // timestamp appended onto an already-ordered list — `merged` is ALREADY in
  // display order, so the O(n log n) sort is pure overhead on the membership-
  // changing send frame (where this whole merge re-runs because the caches
  // correctly bust). Detect that with an O(n) adjacency scan and skip the
  // sort; otherwise sort exactly as before. Behavior-identical either way: a
  // stable sort of an already-sorted array leaves it unchanged, so the skipped
  // branch returns the same ordering the sort would have produced.
  return orderByResolver(merged, getSortTimestamp);
};

const getAssistantUserMessageId = (
  message: MessageRecord,
): string | undefined => {
  if (message.type !== "assistant_message") return undefined;
  const payload = message.payload as { userMessageId?: string } | undefined;
  const userMessageId = payload?.userMessageId;
  return typeof userMessageId === "string" && userMessageId.length > 0
    ? userMessageId
    : undefined;
};

export const getPersistedAssistantSlots = (
  persistedMessages: MessageRecord[],
): Map<string, MessageRecord[]> => {
  const slots = new Map<string, MessageRecord[]>();
  for (const message of persistedMessages) {
    const userMessageId = getAssistantUserMessageId(message);
    if (!userMessageId) continue;
    const current = slots.get(userMessageId);
    if (current) {
      current.push(message);
    } else {
      slots.set(userMessageId, [message]);
    }
  }
  return slots;
};

/**
 * Materialize a streaming overlay slot into a `MessageRecord` so it
 * slots into the timeline alongside persisted assistant messages.
 * When the matching persisted row exists, keep the live row's text and
 * synthetic id but borrow canonical persisted metadata/decorations.
 */
export const overlayToMessageRecord = (
  overlay: StreamingAssistantOverlay,
  persisted?: MessageRecord,
): MessageRecord => ({
  ...(persisted ?? {}),
  _id: overlay._id,
  timestamp: overlay.timestamp,
  type: "assistant_message",
  payload: {
    ...(persisted?.payload ?? {}),
    text: overlay.text,
    userMessageId: overlay.userMessageId,
    metadata: {
      ...((
        persisted?.payload as { metadata?: Record<string, unknown> } | undefined
      )?.metadata ?? {}),
      runtime: {
        ...((
          persisted?.payload as
            | { metadata?: { runtime?: Record<string, unknown> } }
            | undefined
        )?.metadata?.runtime ?? {}),
        isStreaming: !overlay.locked,
        ...(overlay.responseTarget
          ? { responseTarget: overlay.responseTarget }
          : {}),
      },
    },
  },
  toolEvents: persisted?.toolEvents ?? [],
});

export const mergeConversationDisplayMessageSources = (args: {
  persistedMessages: MessageRecord[];
  overlayMessages: MessageRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
  persistedAssistantSlots: Map<string, MessageRecord[]>;
  /**
   * Optional stable sort-timestamp resolver. When omitted, messages sort by
   * their own `timestamp` (unchanged behavior). The hook passes one only when
   * at least one assistant slot was seen live this session, so a persisted
   * twin inherits the sort position its streaming overlay first held instead
   * of hopping to the runtime's (different) message timestamp.
   */
  getSortTimestamp?: SortTimestampResolver;
}): MessageRecord[] => {
  const {
    persistedMessages,
    overlayMessages,
    streamingAssistants,
    persistedAssistantSlots,
    getSortTimestamp = defaultSortTimestamp,
  } = args;
  const resolverActive = getSortTimestamp !== defaultSortTimestamp;
  const persistedById = new Map(
    persistedMessages.map((message) => [message._id, message]),
  );
  if (streamingAssistants.length === 0) {
    if (overlayMessages.length === 0) {
      // SQLite is ordered by persistence time. Assistant rows with a captured
      // `streamStartedAtMs` sort by when their text first became visible, so a
      // queued user send cannot jump above an assistant it followed.
      return orderByResolver(persistedMessages, getSortTimestamp);
    }
    return mergeMessageSources(
      getSortTimestamp,
      persistedMessages,
      overlayMessages,
    );
  }

  const maskedPersistedIds = new Set<string>();
  for (const slot of streamingAssistants) {
    const persisted = slot.canonicalMessageId
      ? persistedById.get(slot.canonicalMessageId)
      : persistedAssistantSlots.get(slot.userMessageId)?.[
          slot.indexInTurn - 1
        ];
    if (persisted) {
      maskedPersistedIds.add(persisted._id);
    }
  }

  const persistedMessagesForDisplay =
    maskedPersistedIds.size === 0
      ? persistedMessages
      : persistedMessages.filter(
          (message) => !maskedPersistedIds.has(message._id),
        );

  if (overlayMessages.length === 0) {
    return resolverActive
      ? orderByResolver(persistedMessagesForDisplay, getSortTimestamp)
      : persistedMessagesForDisplay;
  }
  return mergeMessageSources(
    getSortTimestamp,
    persistedMessagesForDisplay,
    overlayMessages,
  );
};

/* -------------------------------------------------------------------------
 * Structural-sharing fast path for the per-delta merge.
 *
 * `mergeConversationDisplayMessageSources` builds a dedup Map, runs a full
 * O(n log n) sort, and (when masking) allocates a filtered copy — all of it
 * on EVERY streamed delta, because the live overlay grows each frame and
 * `streamingAssistants` / `overlayMessages` change identity. In a long thread
 * that O(n log n) + allocations is the largest length-scaling cost on the
 * auto-scroll critical path.
 *
 * But during pure text streaming the ONLY thing that changes is the live
 * overlay's CONTENT. The persisted set keeps a stable array reference
 * (`stabilizeMessageList`), and every participant's `_id` / `timestamp` /
 * `type` — hence the dedup outcome, the sort order, the membership, and the
 * masking (overlay ids encode `userMessageId:indexInTurn`) — is identical to
 * the previous delta. So the merged ordering can be reused wholesale and only
 * the overlay objects swapped in by id, skipping the dedup + sort + filter.
 *
 * The three helpers below are pure so the equivalence is unit-testable.
 * ----------------------------------------------------------------------- */

/**
 * Positions in a merged `result` that were contributed by an overlay message
 * (vs a persisted message), identified by object reference — the merge stores
 * the actual winning object, so an element that is one of `overlayMessages`
 * is exactly an overlay winner. Recomputed only on a full merge.
 */
export const findOverlayWinnerIndices = (
  result: MessageRecord[],
  overlayMessages: MessageRecord[],
): number[] => {
  if (overlayMessages.length === 0) return [];
  const overlaySet = new Set<MessageRecord>(overlayMessages);
  const indices: number[] = [];
  for (let i = 0; i < result.length; i += 1) {
    if (overlaySet.has(result[i]!)) indices.push(i);
  }
  return indices;
};

/**
 * Whether two overlay-message lists describe the same MERGE SHAPE — same
 * length and same `(_id, timestamp, type)` at each position. Overlay objects
 * are rebuilt every streamed delta (their text grows), but while only content
 * changed the id/timestamp/type sequence is identical. Combined with a stable
 * persisted set, that guarantees the dedup outcome, sort order, membership,
 * and masking are unchanged, so the cached merged order may be reused.
 */
export const overlayMergeShapeUnchanged = (
  prev: MessageRecord[],
  next: MessageRecord[],
): boolean => {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a._id !== b._id || a.timestamp !== b.timestamp || a.type !== b.type) {
      return false;
    }
  }
  return true;
};

/**
 * Rebuild a merged list from a cached sorted order, replacing only the
 * overlay-winner positions with the CURRENT overlay objects (looked up by id)
 * so the grown text/metadata is reflected — without re-running dedup or sort.
 * Persisted-winner positions keep their cached object (stable reference under
 * the caller's preconditions). Returns `null` if any overlay-winner id is
 * absent from the current overlay set (an anomaly the precondition should
 * prevent), so the caller can fall back to a full merge.
 */
export const rebuildDisplayMessagesFromCachedOrder = (
  cachedResult: MessageRecord[],
  overlayWinnerIndices: number[],
  currentOverlayMessages: MessageRecord[],
): MessageRecord[] | null => {
  // No overlay contributed to the output (e.g. nothing streaming): the result
  // is purely persisted objects, unchanged under the caller's preconditions.
  if (overlayWinnerIndices.length === 0) return cachedResult;
  const currentOverlayById = new Map<string, MessageRecord>();
  for (const m of currentOverlayMessages) currentOverlayById.set(m._id, m);
  const next = cachedResult.slice();
  for (const idx of overlayWinnerIndices) {
    const current = currentOverlayById.get(next[idx]!._id);
    if (!current) return null;
    next[idx] = current;
  }
  return next;
};

type DisplayMessagesCache = {
  persistedMessages: MessageRecord[];
  persistedAssistantSlots: Map<string, MessageRecord[]>;
  overlayMessages: MessageRecord[];
  overlayWinnerIndices: number[];
  result: MessageRecord[];
};

export const useConversationDisplayMessages = ({
  conversationId,
  persistedMessages,
  optimisticEvents,
  streamingAssistants,
}: UseConversationDisplayMessagesOptions): MessageRecord[] => {
  const scheduledEvents = useScheduledEvents({
    conversationId: conversationId ?? undefined,
    enabled: Boolean(conversationId),
    maxItems: SCHEDULED_EVENTS_OVERLAY_MAX,
  });

  const persistedAssistantSlots = useMemo(
    () => getPersistedAssistantSlots(persistedMessages),
    [persistedMessages],
  );
  const persistedMessagesById = useMemo(
    () => new Map(persistedMessages.map((message) => [message._id, message])),
    [persistedMessages],
  );

  /**
   * Per-slot frozen sort timestamps (`userMessageId:indexInTurn` -> ts).
   *
   * A streaming assistant overlay sorts by a renderer `Date.now()` captured at
   * its first chunk (message START), while the persisted twin that later
   * replaces it sorts by the runtime's `message.timestamp` (message END). Those
   * two values differ, so at the overlay -> persisted handoff (message
   * finalizes, or the next run drops the prior-run overlay) the row's sort key
   * changes. If any adjacent row's timestamp falls between the two, the row
   * re-sorts across it and its card/artifact visibly hops before/after the
   * neighbor.
   *
   * We freeze the FIRST sort timestamp observed for each slot (the overlay's
   * value) and reuse it for the persisted twin for the rest of this session, so
   * the position a card first rendered at never changes. Reset per conversation;
   * a reload starts empty and falls back to canonical persisted timestamps.
   */
  const frozenSlotSortTsRef = useRef<Map<string, number>>(new Map());
  const frozenConversationIdRef = useRef<string | null>(conversationId);
  if (frozenConversationIdRef.current !== conversationId) {
    frozenConversationIdRef.current = conversationId;
    frozenSlotSortTsRef.current = new Map();
  }
  for (const slot of streamingAssistants) {
    const slotKey = `${slot.userMessageId}:${slot.indexInTurn}`;
    if (!frozenSlotSortTsRef.current.has(slotKey)) {
      frozenSlotSortTsRef.current.set(slotKey, slot.timestamp);
    }
  }

  // Map each persisted assistant twin whose slot was seen live this session to
  // its frozen sort timestamp. Recomputed only when the persisted slots change
  // or a new overlay appears — i.e. exactly the handoff frames that matter.
  const sortTimestampByMessageId = useMemo(() => {
    const map = new Map<string, number>();
    const frozen = frozenSlotSortTsRef.current;
    if (frozen.size === 0) return map;
    for (const [userMessageId, slotMessages] of persistedAssistantSlots) {
      for (let i = 0; i < slotMessages.length; i += 1) {
        const frozenTs = frozen.get(`${userMessageId}:${i + 1}`);
        if (frozenTs !== undefined) {
          map.set(slotMessages[i]!._id, frozenTs);
        }
      }
    }
    for (const slot of streamingAssistants) {
      if (slot.canonicalMessageId) {
        map.set(slot.canonicalMessageId, slot.timestamp);
      }
    }
    return map;
  }, [persistedAssistantSlots, streamingAssistants]);

  const getSortTimestamp = useMemo<SortTimestampResolver | undefined>(() => {
    if (sortTimestampByMessageId.size === 0) return undefined;
    return (message) =>
      sortTimestampByMessageId.get(message._id) ??
      getMessageChronologicalTimestamp(message);
  }, [sortTimestampByMessageId]);

  const overlayMessages = useMemo(() => {
    const overlayEvents: EventRecord[] = [];
    for (const event of optimisticEvents) overlayEvents.push(event);
    for (const event of scheduledEvents) {
      if (event.type !== "user_message" && event.type !== "assistant_message") {
        continue;
      }
      if (overlayEvents.some((other) => other._id === event._id)) continue;
      overlayEvents.push(event);
    }
    const fromEvents =
      overlayEvents.length > 0 ? groupEventsIntoMessages(overlayEvents) : [];

    const streamingOverlay: MessageRecord[] = [];
    for (const slot of streamingAssistants) {
      const persisted = slot.canonicalMessageId
        ? persistedMessagesById.get(slot.canonicalMessageId)
        : persistedAssistantSlots.get(slot.userMessageId)?.[
            slot.indexInTurn - 1
          ];
      streamingOverlay.push(overlayToMessageRecord(slot, persisted));
    }

    if (fromEvents.length === 0 && streamingOverlay.length === 0) {
      return [] as MessageRecord[];
    }
    return [...fromEvents, ...streamingOverlay];
  }, [
    optimisticEvents,
    persistedAssistantSlots,
    persistedMessagesById,
    scheduledEvents,
    streamingAssistants,
  ]);

  const cacheRef = useRef<DisplayMessagesCache | null>(null);

  const merged = useMemo(() => {
    const cache = cacheRef.current;
    // Fast path: only the live overlay's content changed since the last
    // delta. Preconditions guaranteeing an identical merge ORDER + membership
    // + masking (so only overlay objects need swapping in):
    //   - persisted set is the same array reference (stabilizeMessageList
    //     yields a new reference on ANY membership/order/identity change, so
    //     this also catches an edited persisted message that kept its id);
    //   - the persisted assistant-slot index (the masking input) is the same
    //     reference;
    //   - the overlay list has the same (_id, timestamp, type) sequence
    //     (overlay ids encode userMessageId:indexInTurn, so this also pins the
    //     masking inputs and the sort keys).
    if (
      cache &&
      cache.persistedMessages === persistedMessages &&
      cache.persistedAssistantSlots === persistedAssistantSlots &&
      overlayMergeShapeUnchanged(cache.overlayMessages, overlayMessages)
    ) {
      const reused = rebuildDisplayMessagesFromCachedOrder(
        cache.result,
        cache.overlayWinnerIndices,
        overlayMessages,
      );
      if (reused) {
        // Keep the cache aligned with the freshest overlay objects/arrays so
        // the next delta diffs + swaps against current state. The winner
        // indices are unchanged (order/membership identical).
        cache.result = reused;
        cache.overlayMessages = overlayMessages;
        return reused;
      }
    }

    const result = mergeConversationDisplayMessageSources({
      persistedMessages,
      overlayMessages,
      streamingAssistants,
      persistedAssistantSlots,
      ...(getSortTimestamp ? { getSortTimestamp } : {}),
    });
    cacheRef.current = {
      persistedMessages,
      persistedAssistantSlots,
      overlayMessages,
      overlayWinnerIndices: findOverlayWinnerIndices(result, overlayMessages),
      result,
    };
    return result;
  }, [
    getSortTimestamp,
    overlayMessages,
    persistedAssistantSlots,
    persistedMessages,
    streamingAssistants,
  ]);

  /**
   * Arrival-order anchoring for agent lifecycle events (see
   * `routeLifecycleEvents`). Runs on the merged timeline so cards routed
   * mid-stream can target the streaming overlay row itself; the sticky map
   * pins every decision for the session so the overlay -> persisted handoff
   * can never move an already-painted card. Reset per conversation, like the
   * frozen sort timestamps above.
   */
  const lifecycleRoutingRef = useRef<LifecycleRoutingState>(
    createLifecycleRoutingState(),
  );
  const routingConversationIdRef = useRef<string | null>(conversationId);
  if (routingConversationIdRef.current !== conversationId) {
    routingConversationIdRef.current = conversationId;
    lifecycleRoutingRef.current = createLifecycleRoutingState();
  }

  return useMemo(
    () => routeLifecycleEvents(merged, lifecycleRoutingRef.current),
    [merged],
  );
};
