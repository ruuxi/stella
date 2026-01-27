import type { EventRecord } from "../hooks/use-conversation-events";
import { WorkingIndicator } from "../components/chat/WorkingIndicator";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  isStreaming?: boolean;
  onOpenAttachment?: (attachment: {
    id?: string;
    url?: string;
    mimeType?: string;
  }) => void;
};

const getEventText = (event: EventRecord) => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as {
      text?: string;
      result?: string;
      error?: string;
    };
    if (payload.text) return payload.text;
    if (event.type === "task_completed" && payload.result) return payload.result;
    if (event.type === "task_failed" && payload.error) return payload.error;
  }
  return "";
};

const getAttachments = (event: EventRecord) => {
  if (event.payload && typeof event.payload === "object") {
    return (
      (event.payload as {
        attachments?: Array<{ id?: string; url?: string; mimeType?: string }>;
      }).attachments ?? []
    );
  }
  return [];
};

const formatFallback = (event: EventRecord) => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as {
      taskId?: string;
      description?: string;
      agentType?: string;
      error?: string;
    };
    if (event.type === "task_started") {
      return `Task started: ${payload.description ?? payload.taskId ?? "task"}`;
    }
    if (event.type === "task_completed") {
      return `Task completed: ${payload.taskId ?? "task"}`;
    }
    if (event.type === "task_failed") {
      return `Task failed: ${payload.error ?? payload.taskId ?? "task"}`;
    }
  }
  if (event.type === "tool_request") {
    return `Tool request -> ${event.targetDeviceId ?? "unknown device"}`;
  }
  if (event.type === "tool_result") {
    return `Tool result - ${event.requestId ?? "request"}`;
  }
  if (event.type === "screen_event") {
    return "Screen event";
  }
  return event.type.replace("_", " ");
};

export const ConversationEvents = ({
  events,
  maxItems,
  streamingText,
  isStreaming,
  onOpenAttachment,
}: Props) => {
  const visible = maxItems ? events.slice(-maxItems) : events;
  const showStreaming = Boolean(isStreaming || streamingText);

  // Filter to only show user and assistant messages for cleaner UI
  const messageEvents = visible.filter(
    (e) => e.type === "user_message" || e.type === "assistant_message"
  );

  return (
    <div className="event-list">
      {messageEvents.length === 0 && !showStreaming ? (
        <div className="event-empty">Start a conversation</div>
      ) : (
        <>
          {messageEvents.map((event) => {
            const text = getEventText(event);
            const attachments = getAttachments(event);
            const isUser = event.type === "user_message";

            return (
              <div key={event._id} className="session-turn">
                {/* User message header */}
                {isUser && text && (
                  <div className="session-turn-header">
                    <div className="session-turn-title">{text.length > 60 ? `${text.slice(0, 60)}...` : text}</div>
                  </div>
                )}

                {/* Message content */}
                <div className={`event-item ${isUser ? "user" : "assistant"}`}>
                  <div className="event-body">
                    {text || formatFallback(event)}
                  </div>
                  {attachments.length > 0 && (
                    <div className="event-attachments">
                      {attachments.map((attachment, index) => {
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
                              onKeyDown={(eventKey) => {
                                if (
                                  onOpenAttachment &&
                                  (eventKey.key === "Enter" ||
                                    eventKey.key === " ")
                                ) {
                                  onOpenAttachment(attachment);
                                }
                              }}
                            />
                          );
                        }
                        return (
                          <div
                            key={attachment.id ?? `${index}`}
                            className="event-attachment-fallback"
                          >
                            Attachment {index + 1}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Streaming indicator */}
          {showStreaming && (
            <div className="session-turn">
              <div className="event-item assistant streaming">
                <WorkingIndicator
                  status={streamingText && streamingText.trim().length > 0 ? "Responding" : "Thinking"}
                />
                {streamingText && streamingText.trim().length > 0 && (
                  <div className="event-body">{streamingText}</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
