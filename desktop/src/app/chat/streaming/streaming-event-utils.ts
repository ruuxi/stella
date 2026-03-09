import type { EventRecord } from "@/app/chat/lib/event-transforms";

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

type FindQueuedFollowUpOptions = {
  minTimestamp?: number;
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
  options?: FindQueuedFollowUpOptions,
): { event: EventRecord; attachments: TAttachment[] } | null => {
  const minTimestamp = options?.minTimestamp;
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
    if (typeof minTimestamp === "number" && event.timestamp < minTimestamp) continue;
    if (!event.payload || typeof event.payload !== "object") continue;
    const payload = event.payload as FollowUpPayload<TAttachment>;
    if (payload.mode !== "follow_up") continue;
    if (responded.has(event._id)) continue;
    return { event, attachments: payload.attachments ?? [] };
  }

  return null;
};

