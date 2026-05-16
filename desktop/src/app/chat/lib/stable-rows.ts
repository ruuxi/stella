/**
 * Structural-sharing helpers for the chat pipeline.
 *
 * The chat surface re-runs `useConversationEventFeed` whenever the local
 * SQLite event store updates (and on every Convex pagination tick in the
 * cloud path). Each fetch hands back a fresh `EventRecord[]` of fresh
 * objects, which would invalidate every downstream `useMemo` that depends
 * on the array — turn grouping, derived display state, the per-turn view
 * models passed to row components. With long chats that's O(N) work per
 * stream chunk and forces React to walk the full list on every keystroke
 * worth of streamed text.
 *
 * `stabilizeEventList` and `stabilizeTurnRows` are the t3code-style
 * fix: keep a `byId` map across renders, reuse the prior reference for
 * any entry whose content hasn't changed, and reuse the entire result
 * array when nothing changed at all. Downstream `useMemo` chains then
 * bail out cheaply, and each row component's `memo(..., areEqual)`
 * short-circuits on the `prev.row === next.row` reference check rather
 * than running a deep compare per row.
 */
import type {
  EventRecord,
  MessageRecord,
} from "../../../../../runtime/contracts/local-chat.js";

export type StableEventListState = {
  byId: Map<string, EventRecord>;
  result: EventRecord[];
};

/**
 * Returns a stable `EventRecord[]` derived from `current`, reusing prior
 * references for events with the same `_id`. Stella's chat event store is
 * append-only — events are written once with a unique `_id` and never
 * mutated in place — so identity by `_id` is sufficient.
 *
 * The wrapping array is also reused when its contents are reference-
 * identical to the previous result, so React `useMemo` chains keyed off
 * the array stay valid between fetches.
 */
export const stabilizeEventList = (
  current: EventRecord[],
  previous: StableEventListState | null,
): StableEventListState => {
  const nextById = new Map<string, EventRecord>();
  const nextResult: EventRecord[] = new Array(current.length);
  let anyChanged =
    previous === null || current.length !== previous.result.length;

  for (let i = 0; i < current.length; i += 1) {
    const incoming = current[i];
    const prior = previous?.byId.get(incoming._id);
    const stable = prior ?? incoming;
    nextById.set(incoming._id, stable);
    nextResult[i] = stable;
    if (!anyChanged && previous && previous.result[i] !== stable) {
      anyChanged = true;
    }
  }

  if (!anyChanged && previous) {
    return previous;
  }

  return { byId: nextById, result: nextResult };
};

export type StableTurnRowsState<T extends { id: string }> = {
  byId: Map<string, T>;
  result: T[];
};

/**
 * Returns a stable `T[]` (typically `EventRowViewModel[]`) derived from
 * `current`, reusing prior references for entries whose content is
 * shallow-equal under `isEqual`. Mirrors t3code's
 * `computeStableMessagesTimelineRows`.
 *
 * `isEqual` is called per-row only when the incoming reference differs
 * from the previously stored one; supply a fast field-wise comparison
 * (the chat pipeline uses `eventRowEqual` from `lib/row-equality`).
 */
export const stabilizeTurnRows = <T extends { id: string }>(
  current: T[],
  previous: StableTurnRowsState<T> | null,
  isEqual: (a: T, b: T) => boolean,
): StableTurnRowsState<T> => {
  const nextById = new Map<string, T>();
  const nextResult: T[] = new Array(current.length);
  let anyChanged =
    previous === null || current.length !== previous.result.length;

  for (let i = 0; i < current.length; i += 1) {
    const incoming = current[i];
    const prior = previous?.byId.get(incoming.id);
    const stable = prior && isEqual(prior, incoming) ? prior : incoming;
    nextById.set(incoming.id, stable);
    nextResult[i] = stable;
    if (!anyChanged && previous && previous.result[i] !== stable) {
      anyChanged = true;
    }
  }

  if (!anyChanged && previous) {
    return previous;
  }

  return { byId: nextById, result: nextResult };
};

export type StableMessageListState = {
  byId: Map<string, MessageRecord>;
  result: MessageRecord[];
};

const sameToolEventIds = (
  a: EventRecord[] | undefined,
  b: EventRecord[] | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!._id !== b[i]!._id) return false;
  }
  return true;
};

/**
 * Structural-sharing for `MessageRecord[]` (the messages-stream shape).
 * Reuses prior message refs when `_id`, `timestamp`, `payload` ref, and
 * `toolEvents` id sequence all match. The IPC layer returns fresh objects
 * on every refresh, so without this every `useMemo` downstream would
 * invalidate per stream tick — same problem `stabilizeEventList` solves
 * for the legacy raw-event stream.
 */
export const stabilizeMessageList = (
  current: MessageRecord[],
  previous: StableMessageListState | null,
): StableMessageListState => {
  const nextById = new Map<string, MessageRecord>();
  const nextResult: MessageRecord[] = new Array(current.length);
  let anyChanged =
    previous === null || current.length !== previous.result.length;

  for (let i = 0; i < current.length; i += 1) {
    const incoming = current[i]!;
    const prior = previous?.byId.get(incoming._id);
    const sameShape =
      prior !== undefined &&
      prior.timestamp === incoming.timestamp &&
      prior.type === incoming.type &&
      prior.payload === incoming.payload &&
      sameToolEventIds(prior.toolEvents, incoming.toolEvents);
    const stable = sameShape ? prior! : incoming;
    nextById.set(incoming._id, stable);
    nextResult[i] = stable;
    if (!anyChanged && previous && previous.result[i] !== stable) {
      anyChanged = true;
    }
  }

  if (!anyChanged && previous) {
    return previous;
  }

  return { byId: nextById, result: nextResult };
};

/**
 * Enforces an upper bound on the materialized event window. Mirrors the
 * t3code-style bounded window cap: once a chat balloons past
 * that many events the renderer drops the oldest entries to bound DOM
 * growth, in-flight `useMemo` work, and JS heap pressure. Apply this
 * AFTER `stabilizeEventList` so individual event refs stay shared, then
 * pass `previous` so the wrapping array reference is also reused when
 * the window slice is contents-identical to the previous render.
 */
const MAX_RENDERED_EVENTS = 500;

export const capEventWindow = (
  events: EventRecord[],
  previous: EventRecord[] | null,
): EventRecord[] => {
  const next =
    events.length > MAX_RENDERED_EVENTS
      ? events.slice(events.length - MAX_RENDERED_EVENTS)
      : events;

  if (previous && previous.length === next.length) {
    let identical = true;
    for (let i = 0; i < next.length; i += 1) {
      if (previous[i] !== next[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return previous;
    }
  }

  return next;
};
