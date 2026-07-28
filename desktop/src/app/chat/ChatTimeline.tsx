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
 *    `min-height` lives on the `ListFooterComponent`; the collapsed queue is
 *    one keyed list item after every active assistant slot.
 *  - Older-history pagination is driven by the scroll hook's native input
 *    listener, not Legend's data-sensitive `onStartReached` callback.
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
} from "@legendapp/list/react";
import {
  AssistantMessageRow,
  UserMessageRow,
} from "@/app/chat/MessageRow";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import {
  InlineWorkingIndicator,
  type InlineWorkingIndicatorMountProps,
} from "./InlineWorkingIndicator";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import {
  buildChatTimelineItems,
  type ChatTimelineItem,
} from "@/features/chat/lib/chat-timeline-items";
import { LoaderCircle } from "@/ui/icons";

type ChatTimelineProps = {
  rows: EventRowViewModel[];
  conversationId?: string | null;
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
  queuedUserMessages?: QueuedUserMessage[];
  /**
   * When provided, the single-message bubble or collapsed queue preview lets
   * the user cancel one queued message and restore its text to the composer.
   */
  onCancelQueued?: (message: QueuedUserMessage) => void;
  /**
   * Claude-style working/agent indicator. Rendered on its own line at the
   * top of the trailing region — directly below the streaming/last
   * assistant message and above any queued user messages. Toggling
   * `active` false plays the hold + grow-out exit; the indicator collapses
   * to nothing when fully idle and re-enters under the next pending turn.
   */
  indicator?: InlineWorkingIndicatorMountProps;
  /**
   * Ref to the underlying Legend List instance. Surfaces (full chat,
   * sidebar) own their own scroll-management hook and forward the ref
   * here so the hook can call `scrollToEnd`/`getState` etc.
   */
  listRef?: RefObject<LegendListRef | null>;
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

/* ------------------------------------------------------------------
 * Chat vertical-rhythm contract — the BETWEEN-rows half.
 *
 * These constants are THE definition of inter-row spacing for every
 * chat surface (full chat, sidebar, mini, orb — they all mount this
 * timeline). They render as virtualized separator heights below each
 * row. The WITHIN-row half (message -> cards -> action strip) is
 * `--chat-item-part-gap` in full-shell.chat.css.
 *
 * When judging perceived spacing remember each text-bearing assistant
 * row ends with an invisible 8px tail (the part gap before the
 * zero-height hover action strip — its buttons overlay the gap below
 * rather than reserving a band), so the visual gap between two
 * assistant paragraphs is `8 + ASSISTANT_RUN_GAP`.
 * ------------------------------------------------------------------ */

/** Turn boundary: spacing across a sender change (user <-> assistant). */
const ROW_GAP = 30;
/**
 * Spacing between two consecutive assistant rows (no user message or
 * other content between them) — tightened so a multi-message assistant
 * reply reads as one continuous block rather than separate turns.
 */
const ASSISTANT_RUN_GAP = 8;
/**
 * Spacing between two consecutive user rows — tightened (vs the full
 * inter-turn `ROW_GAP`) so a burst of back-to-back user messages reads as
 * one grouped sequence rather than a stack of separate turns, while still
 * staying looser than the continuous assistant run.
 */
const USER_RUN_GAP = 10;
/**
 * Spacing between two consecutive card/artifact-only assistant rows
 * (resource cards, source diffs, inline images, schedule receipts, …).
 * Matches the within-row part gap so a run of stacked cards reads as one
 * grouped list. (Card rows used to sit inside 12px+12px of invisible
 * assistant-bubble padding, which is why this could be 0 before; that
 * padding is gone, so the group gap is explicit now.)
 */
const CARD_RUN_GAP = 8;

/**
 * A "card row" is an assistant row whose body is purely an inline
 * artifact card with no message text — these are the rows we want to
 * stack flush when several land back to back.
 */
const isCardRow = (row: EventRowViewModel): boolean =>
  row.kind === "assistant" &&
  row.text.trim().length === 0 &&
  Boolean(
    row.resourcePayload ||
      row.sourceDiffPayloads?.length ||
      row.inlineImagePayloads?.length ||
      row.officePreviewRef ||
      row.scheduleReceipt ||
      row.selfModApplied ||
      row.backgroundWork ||
      row.customSlot,
  );

const gapAfterRow = (
  current: EventRowViewModel,
  next: EventRowViewModel | undefined,
): number => {
  if (!next) return ROW_GAP;
  if (isCardRow(current) && isCardRow(next)) return CARD_RUN_GAP;
  if (current.kind === "assistant" && next.kind === "assistant") {
    return ASSISTANT_RUN_GAP;
  }
  // A run of same-sender user bubbles groups tighter than a cross-sender
  // turn boundary; different-sender turns keep the full inter-turn gap.
  if (current.kind === "user" && next.kind === "user") {
    return USER_RUN_GAP;
  }
  return ROW_GAP;
};

type TimelineListItem = ChatTimelineItem & {
  /** Pre-computed spacing rendered below this row by the separator. */
  gapAfter: number;
};

const ItemSeparator = ({ leadingItem }: { leadingItem: TimelineListItem }) => (
  <div style={{ height: leadingItem.gapAfter }} aria-hidden="true" />
);

const renderRow = (
  row: EventRowViewModel,
  conversationId?: string | null,
) => {
  if (row.kind === "user") {
    return <UserMessageRow key={row.id} row={row} />;
  }
  return (
    <AssistantMessageRow
      key={row.id}
      row={row}
      conversationId={conversationId}
    />
  );
};

const TimelineUserItem = ({
  item,
  onCancelQueued,
}: {
  item: Extract<
    ChatTimelineItem,
    { type: "message" | "queued-users" }
  >;
  onCancelQueued?: (message: QueuedUserMessage) => void;
}) => {
  if (item.type === "queued-users") {
    return (
      <ComposerQueuedMessages
        messages={item.messages}
        onCancel={onCancelQueued}
      />
    );
  }
  return item.row.kind === "user" ? <UserMessageRow row={item.row} /> : null;
};

export const ChatTimeline = memo(function ChatTimeline({
  rows,
  conversationId,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  emptyState,
  extraTail,
  queuedUserMessages,
  onCancelQueued,
  indicator,
  listRef,
  recycleItems = true,
  alignItemsAtEnd = false,
  estimatedItemSize = 120,
  className,
  contentContainerStyle,
}: ChatTimelineProps) {
  const listItems = useMemo<TimelineListItem[]>(() => {
    const items = buildChatTimelineItems({
      rows,
      queuedUserMessages: queuedUserMessages ?? [],
      includeWorkingIndicator: Boolean(indicator),
    });
    return items.map((item, index) => {
      const next = items[index + 1];
      if (item.type === "message") {
        const nextRow = next?.type === "message" ? next.row : undefined;
        return { ...item, gapAfter: gapAfterRow(item.row, nextRow) };
      }
      if (item.type === "working-indicator") {
        return { ...item, gapAfter: next?.type === "queued-users" ? 20 : 0 };
      }
      return {
        ...item,
        gapAfter: next?.type === "queued-users" ? 6 : ROW_GAP,
      };
    });
  }, [indicator, queuedUserMessages, rows]);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<TimelineListItem>) => {
      if (item.type === "working-indicator") {
        return indicator ? (
          <div className="event-list-working-indicator">
            <InlineWorkingIndicator {...indicator} />
          </div>
        ) : null;
      }
      if (item.type === "queued-users" || item.row.kind === "user") {
        return (
          <TimelineUserItem item={item} onCancelQueued={onCancelQueued} />
        );
      }
      return renderRow(item.row, conversationId);
    },
    [conversationId, indicator, onCancelQueued],
  );

  const keyExtractor = useCallback((item: TimelineListItem) => item.id, []);
  const hasQueuedTimelineItem = listItems.some(
    (item) => item.type === "queued-users",
  );

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
   * Footer: any surface-specific `extraTail` node and a bottom-floor
   * `min-height`. Working state and the collapsed queue are keyed list data
   * directly above this footer so a growing/new assistant slot cannot paint
   * below them. The min-height pre-allocates the empty reading
   * area below the just-sent user bubble (and below short streaming
   * replies) without reserving the full viewport. Living here — rather
   * than wrapping the latest user/assistant rows in a re-keyed synthetic
   * list item — means rows never migrate between virtualized contexts on
   * send, so their measured sizes don't collapse into `estimatedItemSize`
   * for a frame and `scrollHeight` doesn't dip back below the user's
   * current `scrollTop`.
   */
  const ListFooter = useMemo(
    () => (
      <div
        className={
          "event-list-trailing-region" +
          (hasQueuedTimelineItem
            ? " event-list-trailing-region--after-queue"
            : "")
        }
      >
        {extraTail && (
          <div className="event-list-extra-tail">{extraTail}</div>
        )}
      </div>
    ),
    [extraTail, hasQueuedTimelineItem],
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
        <LoaderCircle
          className="stella-loader-circle"
          size={18}
          strokeWidth={2}
          aria-hidden="true"
        />
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
      // Scroll UI state is driven by useChatScrollManagement's passive native
      // listener. Legend's web `onScroll` adapter synchronously reads full
      // content geometry on every frame, forcing layout for no useful data.
      // Do not use Legend's `onStartReached`: it deliberately re-enters on a
      // data change while the threshold is visible, so each prepend can load
      // the next page without another user action. The same passive native
      // listener owns the intent-gated two-viewport threshold instead.
      ListHeaderComponent={ListHeader ?? undefined}
      ListFooterComponent={ListFooter}
      ItemSeparatorComponent={ItemSeparator}
      className={className}
      contentContainerStyle={contentContainerStyle}
      style={{ height: "100%", width: "100%" }}
    />
  );
});
