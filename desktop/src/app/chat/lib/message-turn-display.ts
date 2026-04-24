import type { Attachment, ChannelEnvelope } from "@/app/chat/lib/event-transforms";
import {
  getEventText,
  type EventRecord,
  type MessagePayload,
} from "@/app/chat/lib/event-transforms";
import {
  LEADING_TIME_TAG_RE,
  TRAILING_TIME_TAG_RE,
} from "@/shared/lib/message-timestamp";

export const getAttachments = (event: EventRecord): Attachment[] => {
  const fromPayload = (event.payload as MessagePayload | undefined)?.attachments ?? [];
  const fromEnvelope = event.channelEnvelope?.attachments ?? [];
  if (fromEnvelope.length === 0) {
    return fromPayload;
  }

  const deduped = new Map<string, Attachment>();
  for (const attachment of [...fromPayload, ...fromEnvelope]) {
    const key = [
      attachment.id ?? "",
      attachment.url ?? "",
      attachment.name ?? "",
      attachment.mimeType ?? "",
      attachment.kind ?? "",
    ].join("|");
    if (!deduped.has(key)) {
      deduped.set(key, attachment);
    }
  }
  return Array.from(deduped.values());
};

export const getChannelEnvelope = (
  event: EventRecord,
): ChannelEnvelope | undefined => event.channelEnvelope;

const isChannelMessageEvent = (event: EventRecord): boolean => {
  if (event.channelEnvelope && typeof event.channelEnvelope === "object") {
    return true;
  }
  if (!event.payload || typeof event.payload !== "object") {
    return false;
  }
  const source = (event.payload as MessagePayload).source;
  return typeof source === "string" && source.trim().toLowerCase().startsWith("channel:");
};

export const getDisplayMessageText = (event: EventRecord): string => {
  const text = getEventText(event).replace(TRAILING_TIME_TAG_RE, "");
  if (!isChannelMessageEvent(event)) {
    return text;
  }
  return text.replace(LEADING_TIME_TAG_RE, "");
};

export const getDisplayUserText = (event: EventRecord): string => {
  const text = getEventText(event).replace(TRAILING_TIME_TAG_RE, "");
  if (!isChannelMessageEvent(event)) {
    return text;
  }
  return text.replace(LEADING_TIME_TAG_RE, "");
};
