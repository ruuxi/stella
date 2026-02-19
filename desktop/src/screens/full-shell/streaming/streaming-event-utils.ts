import type { EventRecord } from "../../../hooks/use-conversation-events";

export type AppendedEventResponse = {
  _id?: string;
  id?: string;
};

type AssistantMessagePayload = {
  userMessageId?: string;
};

type FollowUpPayload<TAttachment> = {
  mode?: string;
  attachments?: TAttachment[];
};

export const toEventId = (
  event: AppendedEventResponse | null | undefined,
): string | null => {
  if (!event) return null;
  if (typeof event._id === "string" && event._id.length > 0) return event._id;
  if (typeof event.id === "string" && event.id.length > 0) return event.id;
  return null;
};

export const findQueuedFollowUp = <TAttachment>(
  source: EventRecord[],
): { event: EventRecord; attachments: TAttachment[] } | null => {
  const responded = new Set<string>();
  for (const event of source) {
    if (event.type !== "assistant_message") continue;
    if (event.payload && typeof event.payload === "object") {
      const payload = event.payload as AssistantMessagePayload;
      if (payload.userMessageId) {
        responded.add(payload.userMessageId);
      }
    }
  }

  for (const event of source) {
    if (event.type !== "user_message") continue;
    if (!event.payload || typeof event.payload !== "object") continue;
    const payload = event.payload as FollowUpPayload<TAttachment>;
    if (payload.mode !== "follow_up") continue;
    if (responded.has(event._id)) continue;
    return { event, attachments: payload.attachments ?? [] };
  }

  return null;
};
