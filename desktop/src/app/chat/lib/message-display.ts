import type { EventRecord } from "./event-transforms";
import {
  isUiDisplayableChatEvent,
  isUiHiddenChatMessagePayload,
} from "../../../../../runtime/chat-event-visibility.js";

export const isUiHiddenMessagePayload = isUiHiddenChatMessagePayload;

export function isUiDisplayableEvent(event: EventRecord): boolean {
  return isUiDisplayableChatEvent(event);
}

export function filterEventsForUiDisplay(events: EventRecord[]): EventRecord[] {
  return events.filter(isUiDisplayableEvent);
}
