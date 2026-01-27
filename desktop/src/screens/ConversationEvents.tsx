import type { EventRecord } from "../hooks/use-conversation-events";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  isStreaming?: boolean;
};

const getMessageText = (event: EventRecord) => {
  if (event.payload && typeof event.payload === "object") {
    return (event.payload as { text?: string }).text ?? "";
  }
  return "";
};

const formatFallback = (event: EventRecord) => {
  if (event.type === "tool_request") {
    return `Tool request -> ${event.targetDeviceId ?? "unknown device"}`;
  }
  if (event.type === "tool_result") {
    return `Tool result · ${event.requestId ?? "request"}`;
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
