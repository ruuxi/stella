import type { EventRecord } from "../hooks/use-conversation-events";

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

const getMessageText = (event: EventRecord) => {
  if (event.payload && typeof event.payload === "object") {
    return (event.payload as { text?: string }).text ?? "";
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

  return (
    <div className="event-list">
      {visible.length === 0 && !showStreaming ? (
        <div className="event-empty">No events yet.</div>
      ) : (
        <>
          {visible.map((event) => {
            const text = getMessageText(event);
            const attachments = getAttachments(event);
            const role =
              event.type === "user_message"
                ? "user"
                : event.type === "assistant_message"
                  ? "assistant"
                  : "system";
            return (
              <div key={event._id} className={`event-item ${role}`}>
                <div className="event-type">{event.type.replace("_", " ")}</div>
                <div className="event-body">
                  {text ? text : formatFallback(event)}
                  {attachments.length > 0 ? (
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
                      {event.type === "assistant_message" && onOpenAttachment ? (
                        <div className="event-actions">
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => onOpenAttachment(attachments[0])}
                          >
                            Open in Media Viewer
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {showStreaming ? (
            <div className="event-item assistant streaming">
              <div className="event-type">assistant (streaming)</div>
              <div className="event-body">
                {streamingText && streamingText.trim().length > 0
                  ? streamingText
                  : "Thinking..."}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
