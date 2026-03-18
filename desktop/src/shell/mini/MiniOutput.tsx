import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ConversationEvents } from "@/app/chat/ConversationEvents";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

type Props = {
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  showConversation: boolean;
};

export const MiniOutput = ({
  events,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  showConversation,
}: Props) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtTop = el.scrollTop <= 1;
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    shouldAutoScrollRef.current = isAtBottom;
    setAtTop(isAtTop);
    setAtBottom(isAtBottom);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    updateEdges();
  }, [
    events.length,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    showConversation,
    updateEdges,
  ]);

  const cls = [
    "mini-content",
    showConversation && "has-messages",
    atTop && "at-top",
    atBottom && "at-bottom",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={scrollRef} className={cls} onScroll={updateEdges}>
      {showConversation && (
        <div className="mini-conversation">
          <ConversationEvents
            events={events}
            maxItems={5}
            streamingText={streamingText}
            reasoningText={reasoningText}
            isStreaming={isStreaming}
            pendingUserMessageId={pendingUserMessageId}
          />
        </div>
      )}
    </div>
  );
};




