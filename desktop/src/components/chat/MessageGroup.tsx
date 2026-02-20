import type { EventRecord, MessagePayload, Attachment } from "../../hooks/use-conversation-events";
import { WorkingIndicator } from "./WorkingIndicator";
import { Markdown } from "./Markdown";
import { isOrchestratorChatMessagePayload } from "./emotes/message-source";
import { sanitizeAttachmentImageUrl } from "@/lib/url-safety";

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
  const assistantPayload =
    assistantMessage?.payload && typeof assistantMessage.payload === "object"
      ? (assistantMessage.payload as MessagePayload)
      : null;
  const assistantEmotesEnabled = isOrchestratorChatMessagePayload(assistantPayload);
  const hasStreamingContent = Boolean(streamingText && streamingText.trim().length > 0);

  const showWorkingIndicator = isStreaming && !assistantMessage;

  return (
    <div className="message-group">
      <div className="session-turn">
        <div className="event-item user">
          <div className="event-body">{userText}</div>
          {userAttachments.length > 0 && (
            <div className="event-attachments">
              {userAttachments.map((attachment, index) => {
                const safeUrl = sanitizeAttachmentImageUrl(attachment.url);
                if (safeUrl) {
                  return (
                    <img
                      key={attachment.id ?? `${index}`}
                      src={safeUrl}
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

      {showWorkingIndicator && (
        <div className="session-turn">
          <div className="event-item assistant streaming">
            <WorkingIndicator
              isResponding={hasStreamingContent}
              isReasoning={!hasStreamingContent}
              toolName={currentToolName}
            />
            {hasStreamingContent && streamingText && (
              <Markdown
                text={streamingText}
                isAnimating={isStreaming}
                enableEmotes={true}
              />
            )}
          </div>
        </div>
      )}

      {assistantMessage && !isStreaming && (
        <div className="session-turn">
          <div className="event-item assistant">
            <Markdown
              text={assistantText}
              cacheKey={assistantMessage._id}
              enableEmotes={assistantEmotesEnabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}
