/**
 * Home full-chat surface.
 *
 * Projects local `EventRecord[]` into row view models via `useEventRows`
 * and mounts the shared `<ChatTimeline>`.
 */
import {
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { LegendListRef, NativeScrollEvent, NativeSyntheticEvent } from "@legendapp/list/react";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat.js";
import { useEventRows } from "@/features/chat/hooks/use-event-rows";
import { ChatTimeline } from "./ChatTimeline";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";

const USER_MESSAGE_ENTER_MS = 360;

/**
 * Tracks message ids whose enter animation has already played. Module
 * scope so a home→chat transition (ConversationEvents remount) or a
 * dev remount doesn't replay the fade/grow on the same bubble.
 */
const justSentPlayedIds = new Set<string>();
const justSentActiveUntil = new Map<string, number>();

type Props = {
  messages: MessageRecord[];
  conversationId?: string | null;
  maxItems?: number;
  pendingUserMessageId?: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  /** Working/agent indicator rendered below the last assistant message. */
  indicator?: InlineWorkingIndicatorMountProps;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  /** Threaded through to `<ChatTimeline>` → `<LegendList>`. */
  listRef?: RefObject<LegendListRef | null>;
  onListScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onStartReached?: () => void;
  className?: string;
  contentContainerStyle?: CSSProperties;
  estimatedItemSize?: number;
};

/**
 * Returns the set of row ids that should carry `justSent` this frame.
 * Registration runs synchronously during render so the CSS enter
 * animation starts on the bubble's first paint — the previous
 * `useEffect` path painted the row at full opacity, then added the
 * class a frame later, which read as a double appear/re-render on
 * the first send after a cold load (especially when ConversationEvents
 * mounts for the first time on home→chat).
 */
function useOneShotIds(ids: readonly string[], durationMs: number): Set<string> {
  const key = useMemo(() => [...new Set(ids)].sort().join("\n"), [ids]);
  const [tick, setTick] = useState(0);

  const active = useMemo(() => {
    const now = performance.now();
    const set = new Set<string>();
    for (const id of key ? key.split("\n") : []) {
      if (!id) continue;
      if (!justSentPlayedIds.has(id)) {
        justSentPlayedIds.add(id);
        justSentActiveUntil.set(id, now + durationMs);
      }
      const until = justSentActiveUntil.get(id) ?? 0;
      if (until > now) {
        set.add(id);
      }
    }
    return set;
  }, [durationMs, key, tick]);

  useEffect(() => {
    if (active.size === 0) return;
    const now = performance.now();
    let delayMs = durationMs;
    for (const id of active) {
      const until = justSentActiveUntil.get(id) ?? 0;
      delayMs = Math.min(delayMs, Math.max(0, until - now));
    }
    const timeoutId = window.setTimeout(() => {
      setTick((current) => current + 1);
    }, delayMs + 1);
    return () => window.clearTimeout(timeoutId);
  }, [active, durationMs]);

  return active;
}

export const ConversationEvents = memo(function ConversationEvents({
  messages,
  conversationId,
  maxItems,
  pendingUserMessageId,
  queuedUserMessages,
  indicator,
  hasOlderMessages,
  isLoadingOlder,
  isLoadingHistory,
  listRef,
  onListScroll,
  onStartReached,
  className,
  contentContainerStyle,
  estimatedItemSize,
}: Props) {
  const { rows: projectedRows } = useEventRows({
    messages,
    maxItems,
  });

  const justSentCandidates = useMemo(
    () => (pendingUserMessageId ? [pendingUserMessageId] : []),
    [pendingUserMessageId],
  );
  const animatingJustSentIds = useOneShotIds(
    justSentCandidates,
    USER_MESSAGE_ENTER_MS,
  );

  const rows =
    animatingJustSentIds.size > 0
      ? projectedRows.map((row) =>
          row.kind === "user" && animatingJustSentIds.has(row.id)
            ? { ...row, justSent: true }
            : row,
        )
      : projectedRows;

  return (
    <ChatTimeline
      rows={rows}
      conversationId={conversationId}
      hasOlderEvents={hasOlderMessages}
      isLoadingOlder={isLoadingOlder}
      isLoadingHistory={isLoadingHistory}
      queuedUserMessages={queuedUserMessages}
      indicator={indicator}
      listRef={listRef}
      onListScroll={onListScroll}
      onStartReached={onStartReached}
      className={className}
      contentContainerStyle={contentContainerStyle}
      estimatedItemSize={estimatedItemSize}
    />
  );
});
