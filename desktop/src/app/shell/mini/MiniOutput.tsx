import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationEvents } from "../ConversationEvents";
import type { EventRecord } from "../../hooks/use-conversation-events";

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
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 1);
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    updateEdges();
  }, [events.length, streamingText, updateEdges]);

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
