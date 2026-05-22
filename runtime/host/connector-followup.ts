import type { LocalChatUpdatedPayload } from "../contracts/local-chat.js";

export type ConnectorFollowupAction =
  | { type: "ignore" }
  | { type: "clear-target" }
  | { type: "send"; text: string };

const getEventPayload = (
  event: NonNullable<LocalChatUpdatedPayload["event"]>,
): Record<string, unknown> => {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
};

const getSource = (payload: Record<string, unknown>): string =>
  typeof payload.source === "string" ? payload.source : "";

const getTrimmedString = (
  payload: Record<string, unknown>,
  key: string,
): string => {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
};

export const resolveConnectorFollowupAction = (
  payload: LocalChatUpdatedPayload | null,
): ConnectorFollowupAction => {
  const event = payload?.event;
  if (!event) {
    return { type: "ignore" };
  }

  const eventPayload = getEventPayload(event);
  const source = getSource(eventPayload);

  if (event.type === "user_message") {
    return source === "connector"
      ? { type: "ignore" }
      : { type: "clear-target" };
  }

  if (event.type === "assistant_message") {
    if (source === "connector") {
      return { type: "ignore" };
    }
    const text = getTrimmedString(eventPayload, "text");
    return text ? { type: "send", text } : { type: "ignore" };
  }

  return { type: "ignore" };
};
