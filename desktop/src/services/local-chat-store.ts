import { type EventRecord, getEventText } from "@/lib/event-transforms";
import {
  eventsToHistoryMessages,
  selectRecentByTokenBudget,
  estimateContextEventTokens,
  type ContextEvent,
} from "@stella/shared";

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

// In-memory cache to avoid re-parsing the entire JSON blob on every operation
let _cachedStore: LocalStore | null = null;
let _cacheRaw: string | null = null;

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
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % max;
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
    // Return cached store if the raw string hasn't changed
    if (raw === _cacheRaw && _cachedStore) return _cachedStore;
    const parsed = JSON.parse(raw) as Partial<LocalStore> | null;
    if (!parsed || typeof parsed !== "object") return createEmptyStore();
    if (!parsed.conversations || typeof parsed.conversations !== "object") {
      return createEmptyStore();
    }
    const store: LocalStore = {
      version: STORE_VERSION,
      conversations: parsed.conversations as Record<string, LocalConversation>,
    };
    _cachedStore = store;
    _cacheRaw = raw;
    return store;
  } catch (err) {
    console.debug("[local-chat-store] Failed to parse store:", (err as Error).message);
    return createEmptyStore();
  }
};

const writeStore = (store: LocalStore) => {
  if (!canUseStorage()) return;
  const raw = JSON.stringify(store);
  window.localStorage.setItem(STORE_KEY, raw);
  _cachedStore = store;
  _cacheRaw = raw;
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
  } catch (err) {
    console.debug("[local-chat-store] Failed to parse sync checkpoints:", (err as Error).message);
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

const CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_request",
  "tool_result",
  "task_started",
  "task_completed",
  "task_failed",
  "microcompact_boundary",
]);

const DEFAULT_HISTORY_MAX_TOKENS = 24_000;
const DEFAULT_WARNING_THRESHOLD_TOKENS = 170_000;

/**
 * Build history messages using the same pipeline as the cloud/server-side path:
 * token-budgeted event selection, tool call/result formatting, and micro-compaction.
 *
 * Selection is token-budget-based (default 24 000 tokens, matching the backend).
 */
export const buildLocalHistoryMessages = (
  conversationId: string,
): LocalHistoryMessage[] => {
  // Fetch a generous window of raw events
  const events = listLocalEvents(conversationId, 800);

  // Keep only model-context-relevant event types
  const contextEvents = events.filter((e) => CONTEXT_EVENT_TYPES.has(e.type));
  if (contextEvents.length === 0) return [];

  // Select a recent tail within the token budget (newest-first input)
  const newestFirst = [...contextEvents].reverse();
  const selected = selectRecentByTokenBudget({
    itemsNewestFirst: newestFirst,
    maxTokens: DEFAULT_HISTORY_MAX_TOKENS,
    estimateTokens: (e) =>
      estimateContextEventTokens({
        type: e.type,
        payload: e.payload,
        requestId: e.requestId,
      }),
  });

  // Convert back to chronological order for the formatter
  const chronological = [...selected].reverse();

  // Run through the shared formatter (tool call/result formatting, micro-compaction)
  const { messages } = eventsToHistoryMessages(
    chronological as ContextEvent[],
    {
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: DEFAULT_WARNING_THRESHOLD_TOKENS,
      },
    },
  );

  return messages;
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

