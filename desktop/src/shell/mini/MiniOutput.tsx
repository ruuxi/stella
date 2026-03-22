import { CompactConversationSurface } from "@/app/chat/CompactConversationSurface";
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
  return (
    <CompactConversationSurface
      className="mini-content"
      conversationClassName="mini-conversation"
      variant="mini"
      events={events}
      maxItems={5}
      streamingText={streamingText}
      reasoningText={reasoningText}
      isStreaming={isStreaming}
      pendingUserMessageId={pendingUserMessageId}
      showConversation={showConversation}
      trackEdges
    />
  );
};
