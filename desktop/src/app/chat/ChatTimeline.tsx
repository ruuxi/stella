/**
 * Presentational chat timeline.
 *
 * Renders the chat as a virtualized list using `@legendapp/list/react`
 * (Legend List v3 web entry). Both the home full chat and the sidebar
 * mount this same component — they only differ in the props they pass
 * (rows, listRef from their own scroll-management instance)
 * and the surface-level CSS that wraps the list.
 *
 * Virtualization rules of thumb that this surface honors:
 *  - `keyExtractor` → `row.id` (already stabilized by `useEventRows` via
 *    `stabilizeTurnRows`/`eventRowEqual`, so unchanged rows reuse their
 *    React identity).
 *  - `recycleItems` reuses item containers; `useStreamingChat`/
 *    `useEventRows` keep the streaming assistant row's id stable
 *    across the live → persisted handoff so Streamdown's parse cache
 *    and the row's component instance are reused (no remount, no
 *    flash).
 *  - `maintainVisibleContentPosition` replaces the prior column-reverse
 *    + manual `captureResizeAnchor`/`restoreResizeAnchor` dance.
 *  - Every row renders as its own virtualized item, so measurements
 *    survive a user-send turn boundary. The prior "tail synthetic item
 *    that wraps the latest user message + following assistant rows" was
 *    re-keyed on every send (its key tracked `tailRows[0].id`); the
 *    re-key tore down the wrapper, ejected a tall just-finished
 *    assistant reply into `olderRows` as a freshly-mounted virtualized
 *    item (initial size = `estimatedItemSize`), and dropped `scrollHeight`
 *    by the gap between the real assistant height and the estimate. The
 *    browser then clamped `scrollTop` up to the new max — visible as a
 *    jump back to the top of the previous assistant reply just before
 *    the post-send nudge animated back down. The fixed bottom-floor
 *    `min-height` and queued-messages slot live on the `ListFooterComponent`
 *    instead.
 *  - `onStartReached` triggers older-history pagination.
 *
 * Empty / loading-history states render outside the list, matching the
 * previous flat-`.event-list` behavior (the list isn't useful when
 * there's nothing to virtualize and we want full-bleed empty state
 * styling).
 */
import {
  memo,
  useCallback,
  useMemo,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "@legendapp/list/react";
import {
  AssistantMessageRow,
  UserMessageRow,
  type EventRowViewModel,
} from "@/app/chat/MessageRow";
import type { Attachment } from "@/app/chat/lib/event-transforms";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import type { QueuedUserMessage } from "./hooks/use-streaming-chat";
import { Spinner } from "@/ui/spinner";

type ChatTimelineProps = {
  rows: EventRowViewModel[];
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  emptyState?: React.ReactNode;
  /**
   * Surface-specific node appended after the virtualized rows (e.g. the
   * Google Workspace connect card). Stays inside the same scroll
   * container as the conversation but is not part of the active tail.
   */
  extraTail?: React.ReactNode;
  onOpenAttachment?: (attachment: Attachment) => void;
  queuedUserMessages?: QueuedUserMessage[];
  /**
   * Ref to the underlying Legend List instance. Surfaces (full chat,
   * sidebar) own their own scroll-management hook and forward the ref
   * here so the hook can call `scrollToEnd`/`getState` etc.
   */
  listRef?: RefObject<LegendListRef | null>;
  onListScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onStartReached?: () => void;
  /**
   * Per-surface row recycling toggle. Defaults to `true` — recycling
   * reuses outer item containers as rows scroll out of the
   * virtualization window, which is the main perf benefit of legend-list
   * for long threads. Row identity (`row.id` via `keyExtractor`) keeps
   * the inner React subtree fresh per item, so per-row state (user
   * message expand/collapse, hovercards, Streamdown's parse cache) does
   * not leak across recycled containers.
   */
  recycleItems?: boolean;
  /**
   * If true, anchors items to the bottom when the content is shorter
   * than the viewport — matches the prior column-reverse behavior
   * where a short thread sits flush with the composer rather than at
   * the top of the empty viewport. Default true.
   */
  alignItemsAtEnd?: boolean;
  /**
   * Estimated row height — Legend uses this for first-render layout
   * before measuring real items. ~120px matches the average chat row
   * (single-paragraph user bubble + small assistant body); per-surface
   * tuning can override.
   */
  estimatedItemSize?: number;
  /**
   * `className` applied to the list scroll element. Surfaces use this
   * to layer their mask gradient + scrollbar suppression on top of
   * Legend's own scroller styles.
   */
  className?: string;
  /**
   * Style applied to the inner content container — controls centering
   * (max-width), padding, and any per-surface gutter. Item layout is
   * still managed by Legend.
   */
  contentContainerStyle?: CSSProperties;
};

const ItemSeparator = () => <div style={{ height: 20 }} aria-hidden="true" />;

type TimelineListItem = { id: string; row: EventRowViewModel };

const renderRow = (
  row: EventRowViewModel,
  onOpenAttachment?: (attachment: Attachment) => void,
) => {
  if (row.kind === "user") {
    return (
      <UserMessageRow
        key={row.id}
        row={row}
        onOpenAttachment={onOpenAttachment}
      />
    );
  }
  return <AssistantMessageRow key={row.id} row={row} />;
};

export const ChatTimeline = memo(function ChatTimeline({
  rows,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  emptyState,
  extraTail,
  onOpenAttachment,
  queuedUserMessages,
  listRef,
  onListScroll,
  onStartReached,
  recycleItems = true,
  alignItemsAtEnd = false,
  estimatedItemSize = 120,
  className,
  contentContainerStyle,
}: ChatTimelineProps) {
  const listItems = useMemo<TimelineListItem[]>(
    () => rows.map((row) => ({ id: row.id, row })),
    [rows],
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<TimelineListItem>) =>
      renderRow(item.row, onOpenAttachment),
    [onOpenAttachment],
  );

  const keyExtractor = useCallback((item: TimelineListItem) => item.id, []);

  /**
   * Header: only the older-loading status banner. Empty/loading-history
   * fallbacks render before the list, not as a header.
   */
  const ListHeader = useMemo(() => {
    if (!isLoadingOlder || !hasOlderEvents) return null;
    return (
      <div className="event-history-status" role="status" aria-live="polite">
        Loading earlier messages...
      </div>
    );
  }, [hasOlderEvents, isLoadingOlder]);

  /**
   * Footer: bottom-floor min-height + queued user messages, plus any
   * surface-specific `extraTail` node. The min-height
   * pre-allocates the empty reading area below the just-sent user bubble
   * (and below short streaming replies) without reserving the full
   * viewport. Living here — rather than wrapping the latest user/assistant
   * rows in a re-keyed synthetic list item — means rows never migrate
   * between virtualized contexts on send, so their measured sizes don't
   * collapse into `estimatedItemSize` for a frame and `scrollHeight`
   * doesn't dip back below the user's current `scrollTop`.
   */
  const ListFooter = useMemo(
    () => (
      <div className="event-list-trailing-region">
        <ComposerQueuedMessages messages={queuedUserMessages ?? []} />
        {extraTail && (
          <div className="event-list-extra-tail">{extraTail}</div>
        )}
      </div>
    ),
    [extraTail, queuedUserMessages],
  );

  if (isLoadingHistory && rows.length === 0) {
    return (
      <div
        className="event-list-fallback"
        data-loading-history="true"
        role="status"
        aria-live="polite"
        aria-label="Loading conversation"
      >
        <Spinner size="md" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="event-list-fallback" data-empty="true">
        {emptyState ?? <div className="event-empty">Start a conversation</div>}
      </div>
    );
  }

  return (
    <LegendList<TimelineListItem>
      ref={listRef}
      data={listItems}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      estimatedItemSize={estimatedItemSize}
      recycleItems={recycleItems}
      alignItemsAtEnd={alignItemsAtEnd}
      maintainVisibleContentPosition
      initialScrollAtEnd
      onScroll={onListScroll}
      onStartReached={onStartReached}
      onStartReachedThreshold={0.5}
      ListHeaderComponent={ListHeader ?? undefined}
      ListFooterComponent={ListFooter}
      ItemSeparatorComponent={ItemSeparator}
      className={className}
      contentContainerStyle={contentContainerStyle}
      style={{ height: "100%", width: "100%" }}
    />
  );
});
