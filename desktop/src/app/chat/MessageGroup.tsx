import type { Attachment, EventRecord } from "@/app/chat/lib/event-transforms";
import {
  StreamingIndicator,
  TurnItem,
  getAttachments,
  getChannelEnvelope,
  getDisplayMessageText,
} from "./MessageTurn";

type MessageGroupProps = {
  userMessage: EventRecord;
  assistantMessage?: EventRecord;
  isStreaming?: boolean;
  streamingText?: string;
  currentToolName?: string;
  onOpenAttachment?: (attachment: Attachment) => void;
};

export function MessageGroup({
  userMessage,
  assistantMessage,
  isStreaming,
  streamingText,
  onOpenAttachment,
}: MessageGroupProps) {
  const turn = {
    id: userMessage._id,
    userText: getDisplayMessageText(userMessage),
    userAttachments: getAttachments(userMessage),
    userChannelEnvelope: getChannelEnvelope(userMessage),
    assistantText:
      assistantMessage && !isStreaming
        ? getDisplayMessageText(assistantMessage)
        : "",
    assistantMessageId: assistantMessage?._id ?? null,
    assistantEmotesEnabled: true,
  };

  return (
    <div className="message-group">
      <TurnItem turn={turn} isLastTurn onOpenAttachment={onOpenAttachment} />
      {isStreaming && !assistantMessage ? (
        <StreamingIndicator
          streamingText={streamingText}
          isStreaming={isStreaming}
        />
      ) : null}
    </div>
  );
}


