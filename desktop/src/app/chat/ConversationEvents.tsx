/**
 * Home full-chat surface.
 *
 * Projects local `EventRecord[]` into row view models via `useEventRows`
 * and mounts the shared `<ChatTimeline>`. Renders the Google Workspace
 * connect card outside the timeline data — it's a local-chat-only
 * affordance — but threads it into `extraTail` so it lives inside the
 * same Legend List footer as the conversation content.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import type { LegendListRef, NativeScrollEvent, NativeSyntheticEvent } from "@legendapp/list/react";
import type { Attachment } from "@/app/chat/lib/event-transforms";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat.js";
import { GoogleWorkspaceConnectCard } from "@/app/chat/GoogleWorkspaceConnectCard";
import { GrowIn } from "@/app/chat/GrowIn";
import { useEventRows } from "./use-event-rows";
import { ChatTimeline } from "./ChatTimeline";
import type { QueuedUserMessage } from "./hooks/use-streaming-chat";
import {
  acknowledgeGoogleWorkspaceAuthRequired,
  getGoogleWorkspaceAuthRequired,
  subscribeGoogleWorkspaceAuthRequired,
} from "@/global/integrations/google-workspace-auth-state";

const USER_MESSAGE_ENTER_MS = 360;

type Props = {
  messages: MessageRecord[];
  maxItems?: number;
  streamingText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  optimisticUserMessageIds?: string[];
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  onOpenAttachment?: (attachment: Attachment) => void;
  /** Threaded through to `<ChatTimeline>` → `<LegendList>`. */
  listRef?: RefObject<LegendListRef | null>;
  onListScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onStartReached?: () => void;
  className?: string;
  contentContainerStyle?: CSSProperties;
  estimatedItemSize?: number;
};

function useOneShotIds(ids: readonly string[], durationMs: number): Set<string> {
  const playedRef = useRef(new Set<string>());
  const [active, setActive] = useState(() => new Set<string>());
  const key = useMemo(() => [...new Set(ids)].sort().join("\n"), [ids]);

  useEffect(() => {
    if (!key) return;
    const fresh = key
      .split("\n")
      .filter((id) => id && !playedRef.current.has(id));
    if (fresh.length === 0) return;

    fresh.forEach((id) => playedRef.current.add(id));
    setActive((current) => new Set([...current, ...fresh]));

    const timeoutId = window.setTimeout(() => {
      setActive((current) => {
        const next = new Set(current);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
    }, durationMs);

    return () => window.clearTimeout(timeoutId);
  }, [durationMs, key]);

  return active;
}

export const ConversationEvents = memo(function ConversationEvents({
  messages,
  maxItems,
  streamingText,
  isStreaming,
  pendingUserMessageId,
  queuedUserMessages,
  optimisticUserMessageIds,
  hasOlderMessages,
  isLoadingOlder,
  isLoadingHistory,
  onOpenAttachment,
  listRef,
  onListScroll,
  onStartReached,
  className,
  contentContainerStyle,
  estimatedItemSize,
}: Props) {
  const showGwsConnect = useSyncExternalStore(
    subscribeGoogleWorkspaceAuthRequired,
    getGoogleWorkspaceAuthRequired,
    getGoogleWorkspaceAuthRequired,
  );

  const handleGwsConnected = useCallback(() => {
    acknowledgeGoogleWorkspaceAuthRequired();
  }, []);

  const { rows: projectedRows, lastUserRowIndex, pendingAskQuestion } = useEventRows({
    messages,
    maxItems,
    isStreaming,
    pendingUserMessageId,
    streamingText,
  });

  const justSentCandidates = useMemo(() => {
    const ids: string[] = [];
    if (pendingUserMessageId) ids.push(pendingUserMessageId);
    if (optimisticUserMessageIds) ids.push(...optimisticUserMessageIds);
    return ids;
  }, [optimisticUserMessageIds, pendingUserMessageId]);
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
      lastUserRowIndex={lastUserRowIndex}
      pendingAskQuestion={pendingAskQuestion}
      hasOlderEvents={hasOlderMessages}
      isLoadingOlder={isLoadingOlder}
      isLoadingHistory={isLoadingHistory}
      onOpenAttachment={onOpenAttachment}
      queuedUserMessages={queuedUserMessages}
      listRef={listRef}
      onListScroll={onListScroll}
      onStartReached={onStartReached}
      className={className}
      contentContainerStyle={contentContainerStyle}
      estimatedItemSize={estimatedItemSize}
      extraTail={
        <GrowIn animate={true} show={showGwsConnect}>
          <GoogleWorkspaceConnectCard onConnected={handleGwsConnected} />
        </GrowIn>
      }
    />
  );
});
