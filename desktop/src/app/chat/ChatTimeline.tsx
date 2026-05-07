/**
 * Presentational chat timeline.
 *
 * Renders the chat as a virtualized list using `@legendapp/list/react`
 * (Legend List v3 web entry). Both the home full chat and the sidebar
 * mount this same component — they only differ in the props they pass
 * (rows, indicator, listRef from their own scroll-management instance)
 * and the surface-level CSS that wraps the list.
 *
 * Virtualization rules of thumb that this surface honors:
 *  - `keyExtractor` → `row.id` (already stabilized by `useEventRows` via
 *    `stabilizeTurnRows`/`eventRowEqual`, so unchanged rows reuse their
 *    React identity).
 *  - `recycleItems` reuses item containers; `useStreamingChat`/
 *    `useEventRows` keep the streaming assistant row's id stable
 *    across the live → persisted swap so Streamdown's parse cache and
 *    the row's component instance are reused (no remount, no flash).
 *  - `maintainVisibleContentPosition` replaces the prior column-reverse
 *    + manual `captureResizeAnchor`/`restoreResizeAnchor` dance.
 *  - `maintainScrollAtEnd` keeps the user pinned to the bottom while
 *    the streaming row grows line-by-line. The active tail is rendered
 *    as one synthetic list item so its `.event-row-region--tail`
 *    min-height preserves the pre-virtualization "latest user message +
 *    following assistant rows + indicator" floor.
 *  - `onStartReached` triggers older-history pagination.
 *
 * Empty / loading-history states render outside the list, matching the
 * previous flat-`.event-list` behavior (the list isn't useful when
 * there's nothing to virtualize and we want full-bleed empty state
 * styling).
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import {
  AssistantMessageRow,
  PendingAskQuestionRow,
  UserMessageRow,
  type EventRowViewModel,
} from "@/app/chat/MessageRow";
import type { Attachment } from "@/app/chat/lib/event-transforms";
import type { AskQuestionState } from "@/app/chat/AskQuestionBubble";
import {
  InlineWorkingIndicator,
  type InlineWorkingIndicatorMountProps,
} from "./InlineWorkingIndicator";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import type { QueuedUserMessage } from "./hooks/use-streaming-chat";

type ChatTimelineProps = {
  rows: EventRowViewModel[];
  /**
   * Index of the latest user row in `rows`. Everything from this index
   * onward is rendered inside one synthetic virtualized tail item so
   * the old fixed-floor tail region semantics survive virtualization.
   */
  lastUserRowIndex?: number;
  /** Optional pending askQuestion bubble rendered as the final tail row. */
  pendingAskQuestion?: AskQuestionState | null;
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
  /**
   * Inline working indicator inputs. The indicator is always mounted
   * inside the active tail region — when there's no active work the
   * parent passes `active: false` and the indicator plays its hold +
   * grow-out exit before unmounting itself. Mounting it unconditionally
   * is what keeps the exit animation from being skipped.
   */
  indicator?: InlineWorkingIndicatorMountProps;
  queuedUserMessages?: QueuedUserMessage[];
  /**
   * Ref to the underlying Legend List instance. Surfaces (full chat,
   * sidebar) own their own scroll-management hook and forward the ref
   * here so the hook can call `scrollToEnd`/`getState` etc.
   */
  listRef?: RefObject<LegendListRef | null>;
  onListScroll?: (event: Parameters<NonNullable<Parameters<typeof LegendList>[0]["onScroll"]>>[0]) => void;
  onStartReached?: () => void;
  /** Per-surface row recycling toggle. Default true. */
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

type TimelineListItem =
  | { kind: "row"; id: string; row: EventRowViewModel }
  | { kind: "tail"; id: string; rows: EventRowViewModel[] };

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
  lastUserRowIndex = -1,
  pendingAskQuestion = null,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  emptyState,
  extraTail,
  onOpenAttachment,
  indicator,
  queuedUserMessages,
  listRef,
  onListScroll,
  onStartReached,
  recycleItems = false,
  alignItemsAtEnd = false,
  estimatedItemSize = 120,
  className,
  contentContainerStyle,
}: ChatTimelineProps) {
  const tailStart = lastUserRowIndex >= 0 ? lastUserRowIndex : rows.length;
  const olderRows = rows.slice(0, tailStart);
  const tailRows = rows.slice(tailStart);
  const hasTailItem = tailRows.length > 0 || Boolean(pendingAskQuestion);

  const listItems = useMemo<TimelineListItem[]>(() => {
    const items: TimelineListItem[] = olderRows.map((row) => ({
      kind: "row",
      id: row.id,
      row,
    }));
    if (hasTailItem) {
      const tailKey = tailRows[0]?.id ?? "pending-tail";
      items.push({
        kind: "tail",
        id: `tail:${tailKey}`,
        rows: tailRows,
      });
    }
    return items;
  }, [hasTailItem, olderRows, tailRows]);

  let lastAssistantTailIndex = -1;
  let lastAssistantTailRow: EventRowViewModel | null = null;
  for (let i = tailRows.length - 1; i >= 0; i -= 1) {
    if (tailRows[i].kind === "assistant") {
      lastAssistantTailIndex = i;
      lastAssistantTailRow = tailRows[i];
      break;
    }
  }
  const indicatorKey = lastAssistantTailRow
    ? `indicator:${lastAssistantTailRow.id}`
    : "indicator-tail";
  const renderQueuedMessages = () => (
    <ComposerQueuedMessages
      key="queued-user-messages"
      messages={queuedUserMessages ?? []}
    />
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<TimelineListItem>) => {
      if (item.kind === "row") {
        return renderRow(item.row, onOpenAttachment);
      }

      return (
        <div className="event-row-region event-row-region--tail">
          {item.rows.flatMap((row, index) => {
            const node = (
              <Fragment key={row.id}>{renderRow(row, onOpenAttachment)}</Fragment>
            );
            if (indicator && index === lastAssistantTailIndex) {
              return [
                node,
                <InlineWorkingIndicator key={indicatorKey} {...indicator} />,
                renderQueuedMessages(),
              ];
            }
            return [node];
          })}
          {pendingAskQuestion && (
            <PendingAskQuestionRow payload={pendingAskQuestion} />
          )}
          {indicator && lastAssistantTailIndex < 0 && (
            <InlineWorkingIndicator key={indicatorKey} {...indicator} />
          )}
          {(!indicator || lastAssistantTailIndex < 0) && renderQueuedMessages()}
        </div>
      );
    },
    [
      indicator,
      indicatorKey,
      lastAssistantTailIndex,
      onOpenAttachment,
      pendingAskQuestion,
      queuedUserMessages,
    ],
  );

  /**
   * Initial-scroll fallback. `initialScrollAtEnd` can abort during
   * bootstrap when row sizes diverge sharply from `estimatedItemSize`
   * (Legend logs "bootstrap initial scroll aborted after exceeding
   * convergence bounds"). When that happens the list renders rows at
   * `scrollTop: 0` even though the user expects to be at the bottom.
   *
   * Defense in depth: when the row count first becomes non-zero, force
   * a single `scrollToEnd({ animated: false })`. Also re-snap when the
   * row count climbs (new history loads, first-paint of an existing
   * thread). The host owns conversation-change snapping, so we only
   * react to first-content arrival here.
   */
  const hasContentRef = useRef(false);
  useEffect(() => {
    if (rows.length === 0) {
      hasContentRef.current = false;
      return;
    }
    if (hasContentRef.current) return;
    hasContentRef.current = true;
    const list = listRef?.current;
    if (!list) return;
    void list.scrollToEnd({ animated: false });
  }, [listRef, rows.length]);

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

  const ListFooter = useMemo(
    () =>
      extraTail ? <div className="event-list-extra-tail">{extraTail}</div> : null,
    [extraTail],
  );

  if (isLoadingHistory && rows.length === 0) {
    return (
      <div className="event-list" data-loading-history="true">
        <div className="event-history-status" role="status" aria-live="polite">
          Loading conversation...
        </div>
        <div className="thread-placeholder" aria-hidden="true">
          <div className="thread-line" />
          <div className="thread-line short" />
        </div>
        <div className="thread-placeholder" aria-hidden="true">
          <div className="thread-line short" />
          <div className="thread-line" />
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="event-list" data-empty="true">
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
      maintainScrollAtEnd={{ animated: false }}
      // Treat "at end" as essentially-touching-the-bottom (~2% of the
      // viewport, ≈16px on the full chat). At Legend's default of 0.1
      // any scroll-up within ~80px of the bottom is still considered
      // "at end", so the next streaming-token / layout-change event
      // snaps the user back and fights manual scrolling. A small
      // threshold lets the user scroll up freely while still keeping
      // the bottom pinned during real streaming.
      maintainScrollAtEndThreshold={0.02}
      initialScrollAtEnd
      onScroll={onListScroll}
      onStartReached={onStartReached}
      onStartReachedThreshold={0.5}
      ListHeaderComponent={ListHeader ?? undefined}
      ListFooterComponent={ListFooter ?? undefined}
      ItemSeparatorComponent={ItemSeparator}
      className={className}
      contentContainerStyle={contentContainerStyle}
      style={{ height: "100%", width: "100%" }}
    />
  );
});
