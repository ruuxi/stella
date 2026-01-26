import { useQuery } from "convex/react";
import { api } from "../services/convex-api";

type EventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
};

type Props = {
  conversationId: string;
  maxItems?: number;
};

const formatPayloadSummary = (event: EventRecord) => {
  if (event.type === "user_message" || event.type === "assistant_message") {
    return (event.payload?.text as string) ?? "Message";
  }
  if (event.type === "tool_request") {
    return `Tool request → ${event.targetDeviceId ?? "unknown device"}`;
  }
  if (event.type === "tool_result") {
    return `Tool result · ${event.requestId ?? "request"}`;
  }
  if (event.type === "screen_event") {
    return "Screen event";
  }
  return "Event";
};

export const ConversationEvents = ({ conversationId, maxItems }: Props) => {
  const result = useQuery(api.events.listEvents, {
    conversationId,
    paginationOpts: { numItems: 40 },
  }) as { page: EventRecord[] } | undefined;

  const events = result?.page ?? [];
  const ordered = [...events].reverse();
  const visible = maxItems ? ordered.slice(-maxItems) : ordered;

  return (
    <div className="event-list">
      {visible.length === 0 ? (
        <div className="event-empty">No events yet.</div>
      ) : (
        visible.map((event) => (
          <div key={event._id} className="event-item">
            <div className="event-type">{event.type.replace("_", " ")}</div>
            <div className="event-body">{formatPayloadSummary(event)}</div>
          </div>
        ))
      )}
    </div>
  );
};
