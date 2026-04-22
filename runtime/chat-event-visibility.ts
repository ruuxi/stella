export type LocalChatEventWindowMode = "events" | "visible_messages";

type ChatEventLike = {
  type: string;
  payload?: Record<string, unknown>;
};

type ChatMessagePayload = {
  text?: unknown;
  metadata?: {
    ui?: {
      visibility?: unknown;
    };
    trigger?: {
      kind?: unknown;
    };
  };
};

const UI_HIDDEN_TRIGGER_KINDS = new Set<string>([
  "workspace_creation_request",
]);

const isMessageEvent = (event: ChatEventLike): boolean =>
  event.type === "user_message" || event.type === "assistant_message";

const getMessagePayload = (
  event: ChatEventLike,
): ChatMessagePayload | null => {
  if (!event.payload || typeof event.payload !== "object") {
    return null;
  }
  return event.payload as ChatMessagePayload;
};

export const isUiHiddenChatMessagePayload = (
  payload: ChatMessagePayload | null,
): boolean => {
  if (!payload) {
    return false;
  }

  if (payload.metadata?.ui?.visibility === "hidden") {
    return true;
  }

  const triggerKind =
    typeof payload.metadata?.trigger?.kind === "string"
      ? payload.metadata.trigger.kind.trim()
      : "";
  return Boolean(
    triggerKind && UI_HIDDEN_TRIGGER_KINDS.has(triggerKind),
  );
};

export const isUiDisplayableChatEvent = (
  event: ChatEventLike,
): boolean => {
  if (!isMessageEvent(event)) {
    return true;
  }
  return !isUiHiddenChatMessagePayload(getMessagePayload(event));
};

export const isVisibleChatMessageEvent = (
  event: ChatEventLike,
): boolean => isMessageEvent(event) && isUiDisplayableChatEvent(event);

export const countVisibleChatMessageEvents = (
  events: ChatEventLike[],
): number =>
  events.reduce(
    (count, event) => count + (isVisibleChatMessageEvent(event) ? 1 : 0),
    0,
  );

export const sliceEventsByVisibleMessageWindow = <T extends ChatEventLike>(
  events: T[],
  maxVisibleMessages = 200,
): T[] => {
  const normalizedLimit = Math.max(1, Math.floor(maxVisibleMessages));
  let remainingVisibleMessages = normalizedLimit;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!isVisibleChatMessageEvent(events[index]!)) {
      continue;
    }
    remainingVisibleMessages -= 1;
    if (remainingVisibleMessages === 0) {
      return events.slice(index);
    }
  }

  return events;
};
