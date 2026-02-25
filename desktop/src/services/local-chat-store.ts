import type { EventRecord } from "../hooks/use-conversation-events";

const STORE_KEY = "stella.localChat.v1";
const DEFAULT_CONVERSATION_KEY = "stella.localChat.defaultConversationId";
const SYNC_CHECKPOINTS_KEY = "stella.localChat.syncCheckpoints.v1";
const UPDATE_EVENT_NAME = "stella:local-chat-updated";
const STORE_VERSION = 1;
const MAX_EVENTS_PER_CONVERSATION = 2000;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type LocalConversation = {
  id: string;
  updatedAt: number;
  events: EventRecord[];
};

type LocalStore = {
  version: number;
  conversations: Record<string, LocalConversation>;
};

type LocalSyncCheckpoints = Record<string, string>;

export type LocalHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LocalSyncMessage = {
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  deviceId?: string;
};

export type LocalAppendEventArgs = {
  conversationId: string;
  type: string;
  payload?: unknown;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  timestamp?: number;
  eventId?: string;
};

const createEmptyStore = (): LocalStore => ({
  version: STORE_VERSION,
  conversations: {},
});

const canUseStorage = () =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

const encodeBase32 = (value: number, length: number): string => {
  let remaining = Math.floor(value);
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output = ULID_ALPHABET[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
};

const randomIndex = (max: number): number => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(1);
    crypto.getRandomValues(bytes);
    return bytes[0] % max;
  }
  return Math.floor(Math.random() * max);
};

const generateLocalId = () => {
  const time = encodeBase32(Date.now(), 10);
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) {
    randomPart += ULID_ALPHABET[randomIndex(ULID_ALPHABET.length)];
  }
  return `${time}${randomPart}`;
};

const readStore = (): LocalStore => {
  if (!canUseStorage()) return createEmptyStore();
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return createEmptyStore();
    const parsed = JSON.parse(raw) as Partial<LocalStore> | null;
    if (!parsed || typeof parsed !== "object") return createEmptyStore();
    if (!parsed.conversations || typeof parsed.conversations !== "object") {
      return createEmptyStore();
    }
    return {
      version: STORE_VERSION,
      conversations: parsed.conversations as Record<string, LocalConversation>,
    };
  } catch {
    return createEmptyStore();
  }
};

const writeStore = (store: LocalStore) => {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT_NAME));
};

const readSyncCheckpoints = (): LocalSyncCheckpoints => {
  if (!canUseStorage()) return {};
  try {
    const raw = window.localStorage.getItem(SYNC_CHECKPOINTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LocalSyncCheckpoints | null;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
};

const writeSyncCheckpoints = (checkpoints: LocalSyncCheckpoints) => {
  if (!canUseStorage()) return;
  window.localStorage.setItem(SYNC_CHECKPOINTS_KEY, JSON.stringify(checkpoints));
};

const ensureConversation = (store: LocalStore, conversationId: string) => {
  const existing = store.conversations[conversationId];
  if (existing) return existing;
  const created: LocalConversation = {
    id: conversationId,
    updatedAt: Date.now(),
    events: [],
  };
  store.conversations[conversationId] = created;
  return created;
};

const getEventText = (event: EventRecord): string | null => {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const text = payload as {
    text?: unknown;
    content?: unknown;
    message?: unknown;
  };
  if (typeof text.text === "string" && text.text.trim().length > 0) return text.text;
  if (typeof text.content === "string" && text.content.trim().length > 0) return text.content;
  if (typeof text.message === "string" && text.message.trim().length > 0) return text.message;
  return null;
};

const sortEventsAscending = (events: EventRecord[]) =>
  [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a._id.localeCompare(b._id);
  });

export const getOrCreateLocalConversationId = (): string => {
  if (!canUseStorage()) {
    return generateLocalId();
  }
  const existing = window.localStorage.getItem(DEFAULT_CONVERSATION_KEY);
  if (existing && existing.length > 0) {
    return existing;
  }
  const created = generateLocalId();
  window.localStorage.setItem(DEFAULT_CONVERSATION_KEY, created);
  const store = readStore();
  ensureConversation(store, created);
  writeStore(store);
  return created;
};

export const listLocalEvents = (
  conversationId: string,
  maxItems = 200,
): EventRecord[] => {
  const store = readStore();
  const conversation = store.conversations[conversationId];
  if (!conversation) return [];
  const sorted = sortEventsAscending(conversation.events);
  if (sorted.length <= maxItems) return sorted;
  return sorted.slice(sorted.length - maxItems);
};

export const appendLocalEvent = (args: LocalAppendEventArgs): EventRecord => {
  const store = readStore();
  const conversation = ensureConversation(store, args.conversationId);
  const timestamp = args.timestamp ?? Date.now();
  const event: EventRecord = {
    _id: args.eventId ?? `local-${generateLocalId()}`,
    timestamp,
    type: args.type,
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    ...(args.requestId ? { requestId: args.requestId } : {}),
    ...(args.targetDeviceId ? { targetDeviceId: args.targetDeviceId } : {}),
  };

  if (args.payload && typeof args.payload === "object") {
    event.payload = args.payload as Record<string, unknown>;
  }

  conversation.events.push(event);
  if (conversation.events.length > MAX_EVENTS_PER_CONVERSATION) {
    conversation.events.splice(0, conversation.events.length - MAX_EVENTS_PER_CONVERSATION);
  }
  conversation.updatedAt = timestamp;
  store.conversations[args.conversationId] = conversation;
  writeStore(store);
  return event;
};

export const buildLocalHistoryMessages = (
  conversationId: string,
  maxMessages = 50,
): LocalHistoryMessage[] => {
  const events = listLocalEvents(conversationId, maxMessages * 4);
  const history: LocalHistoryMessage[] = [];
  for (const event of events) {
    if (event.type !== "user_message" && event.type !== "assistant_message") {
      continue;
    }
    const content = getEventText(event);
    if (!content) continue;
    history.push({
      role: event.type === "user_message" ? "user" : "assistant",
      content,
    });
  }
  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
};

export const buildLocalSyncMessages = (
  conversationId: string,
  maxMessages = MAX_EVENTS_PER_CONVERSATION,
): LocalSyncMessage[] => {
  const events = listLocalEvents(conversationId, maxMessages * 4);
  const messages: LocalSyncMessage[] = [];
  for (const event of events) {
    if (event.type !== "user_message" && event.type !== "assistant_message") {
      continue;
    }
    const text = getEventText(event);
    if (!text) continue;

    const role = event.type === "user_message" ? "user" : "assistant";
    messages.push({
      localMessageId: event._id,
      role,
      text,
      timestamp: event.timestamp,
      ...(role === "user" && event.deviceId ? { deviceId: event.deviceId } : {}),
    });
  }

  if (messages.length <= maxMessages) return messages;
  return messages.slice(messages.length - maxMessages);
};

export const getLocalSyncCheckpoint = (conversationId: string): string | null => {
  const checkpoints = readSyncCheckpoints();
  const checkpoint = checkpoints[conversationId];
  return typeof checkpoint === "string" && checkpoint.length > 0 ? checkpoint : null;
};

export const setLocalSyncCheckpoint = (conversationId: string, localMessageId: string) => {
  if (!conversationId || !localMessageId) return;
  const checkpoints = readSyncCheckpoints();
  checkpoints[conversationId] = localMessageId;
  writeSyncCheckpoints(checkpoints);
};

export const subscribeToLocalChatUpdates = (listener: () => void): (() => void) => {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onCustomEvent = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORE_KEY || event.key === DEFAULT_CONVERSATION_KEY) {
      listener();
    }
  };

  window.addEventListener(UPDATE_EVENT_NAME, onCustomEvent);
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener(UPDATE_EVENT_NAME, onCustomEvent);
    window.removeEventListener("storage", onStorage);
  };
};
