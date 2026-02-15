import { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, streamingText]);

  return (
    <div
      ref={scrollRef}
      className={`mini-content${showConversation ? " has-messages" : ""}`}
    >
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
