import type { EventRecord, MessagePayload, Attachment } from "../../hooks/use-conversation-events";
import { WorkingIndicator } from "./WorkingIndicator";
import { Markdown } from "./Markdown";

type MessageGroupProps = {
  userMessage: EventRecord;
  assistantMessage?: EventRecord;
  isStreaming?: boolean;
  streamingText?: string;
  currentToolName?: string;
  onOpenAttachment?: (attachment: Attachment) => void;
};

const getMessageText = (event: EventRecord): string => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as MessagePayload;
    // Check common content field names
    return payload.text ?? payload.content ?? payload.message ?? "";
  }
  return "";
};

const getAttachments = (event: EventRecord): Attachment[] => {
  if (event.payload && typeof event.payload === "object") {
    return (event.payload as MessagePayload).attachments ?? [];
  }
  return [];
};

export function MessageGroup({
  userMessage,
  assistantMessage,
  isStreaming,
  streamingText,
  currentToolName,
  onOpenAttachment,
}: MessageGroupProps) {
  const userText = getMessageText(userMessage);
  const userAttachments = getAttachments(userMessage);
  const assistantText = assistantMessage ? getMessageText(assistantMessage) : "";
  const hasStreamingContent = Boolean(streamingText && streamingText.trim().length > 0);

  // Determine if we're still waiting for assistant response
  const showWorkingIndicator = isStreaming && !assistantMessage;

  return (
    <div className="message-group">
      {/* User message */}
      <div className="session-turn">
        <div className="event-item user">
          <div className="event-body">{userText}</div>
          {userAttachments.length > 0 && (
            <div className="event-attachments">
              {userAttachments.map((attachment, index) => {
                if (attachment.url) {
                  return (
                    <img
                      key={attachment.id ?? `${index}`}
                      src={attachment.url}
                      alt="Attachment"
                      className="event-attachment"
                      onClick={() => onOpenAttachment?.(attachment)}
                      role={onOpenAttachment ? "button" : undefined}
                      tabIndex={onOpenAttachment ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (onOpenAttachment && (e.key === "Enter" || e.key === " ")) {
                          onOpenAttachment(attachment);
                        }
                      }}
                    />
                  );
                }
                return (
                  <div key={attachment.id ?? `${index}`} className="event-attachment-fallback">
                    Attachment {index + 1}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Working indicator - shows while streaming without content yet */}
      {showWorkingIndicator && (
        <div className="session-turn">
          <div className="event-item assistant streaming">
            <WorkingIndicator
              isResponding={hasStreamingContent}
              isReasoning={!hasStreamingContent}
              toolName={currentToolName}
            />
            {hasStreamingContent && streamingText && <Markdown text={streamingText} isAnimating={isStreaming} />}
          </div>
        </div>
      )}

      {/* Assistant message - shows completed response */}
      {assistantMessage && !isStreaming && (
        <div className="session-turn">
          <div className="event-item assistant">
            <Markdown text={assistantText} cacheKey={assistantMessage._id} />
          </div>
        </div>
      )}
    </div>
  );
}
