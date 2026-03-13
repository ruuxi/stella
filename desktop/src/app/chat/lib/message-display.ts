import type { EventRecord, MessagePayload } from "./event-transforms";
import { WORKSPACE_CREATION_TRIGGER_KIND } from "@/shared/lib/stella-send-message";

const UI_HIDDEN_TRIGGER_KINDS = new Set<string>([
  WORKSPACE_CREATION_TRIGGER_KIND,
]);

const getMessagePayload = (event: EventRecord): MessagePayload | null => {
  if (!event.payload || typeof event.payload !== "object") {
    return null;
  }
  return event.payload as MessagePayload;
};

const isMessageEvent = (event: EventRecord) =>
  event.type === "user_message" || event.type === "assistant_message";

export function isUiHiddenMessagePayload(payload: MessagePayload | null): boolean {
  if (!payload) {
    return false;
  }

  if (payload.metadata?.ui?.visibility === "hidden") {
    return true;
  }

  const triggerKind = payload.metadata?.trigger?.kind?.trim();
  return Boolean(triggerKind && UI_HIDDEN_TRIGGER_KINDS.has(triggerKind));
}

export function isUiDisplayableEvent(event: EventRecord): boolean {
  if (!isMessageEvent(event)) {
    return true;
  }

  return !isUiHiddenMessagePayload(getMessagePayload(event));
}

export function filterEventsForUiDisplay(events: EventRecord[]): EventRecord[] {
  return events.filter(isUiDisplayableEvent);
}
