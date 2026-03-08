import { type ChannelEnvelope, type EventRecord, getEventText } from "@/app/chat/lib/event-transforms";
import {
  eventsToHistoryMessages,
  type ContextEvent,
} from "@/app/chat/lib/history-messages";
import {
  estimateContextEventTokens,
  selectRecentByTokenBudget,
} from "@/app/chat/lib/context-window";

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
  channelEnvelope?: unknown;
  timestamp?: number;
  eventId?: string;
};

const createEmptyStore = (): LocalStore => ({
  version: STORE_VERSION,
  conversations: {},
});

const canUseStorage = () =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

const hasElectronLocalChatApi = () =>
  typeof window !== "undefined" && Boolean(window.electronAPI?.localChat);

// In-memory cache to avoid re-parsing the entire JSON blob on every operation.
let _cachedStore: LocalStore | null = null;
let _cacheRaw: string | null = null;
let legacyMigrationPromise: Promise<void> | null = null;

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

const fallbackListLocalEvents = (
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

const fallbackGetLocalEventCount = (conversationId: string): number => {
  const store = readStore();
  const conversation = store.conversations[conversationId];
  return conversation?.events.length ?? 0;
};

const fallbackAppendLocalEvent = (args: LocalAppendEventArgs): EventRecord => {
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
  if (args.channelEnvelope && typeof args.channelEnvelope === "object") {
    event.channelEnvelope = args.channelEnvelope as ChannelEnvelope;
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

const fallbackBuildLocalSyncMessages = (
  conversationId: string,
  maxMessages = MAX_EVENTS_PER_CONVERSATION,
): LocalSyncMessage[] => {
  const events = fallbackListLocalEvents(conversationId, maxMessages * 4);
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

const parseLegacyStorePayload = (): Record<string, unknown> | undefined => {
  if (!canUseStorage()) return undefined;
  const raw = window.localStorage.getItem(STORE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.debug("[local-chat-store] Failed to parse legacy local transcript store:", (err as Error).message);
    return undefined;
  }
};

const parseLegacyCheckpointPayload = (): Record<string, unknown> | undefined => {
  if (!canUseStorage()) return undefined;
  const raw = window.localStorage.getItem(SYNC_CHECKPOINTS_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.debug("[local-chat-store] Failed to parse legacy sync checkpoints:", (err as Error).message);
    return undefined;
  }
};

const migrateLegacyLocalStateToElectron = async (): Promise<void> => {
  if (!hasElectronLocalChatApi() || !canUseStorage()) return;
  if (
    !window.localStorage.getItem(STORE_KEY)
    && !window.localStorage.getItem(SYNC_CHECKPOINTS_KEY)
    && !window.localStorage.getItem(DEFAULT_CONVERSATION_KEY)
  ) {
    return;
  }
  if (legacyMigrationPromise) {
    return legacyMigrationPromise;
  }

  legacyMigrationPromise = (async () => {
    const store = parseLegacyStorePayload();
    const syncCheckpoints = parseLegacyCheckpointPayload();
    const defaultConversationId = window.localStorage.getItem(DEFAULT_CONVERSATION_KEY);
    if (!store && !syncCheckpoints && !defaultConversationId) {
      return;
    }

    await window.electronAPI!.localChat.importLegacyData({
      ...(store ? { store: store as {
        version?: number;
        conversations?: Record<string, {
          id?: string;
          updatedAt?: number;
        events?: EventRecord[];
      }>;
      } } : {}),
      ...(syncCheckpoints ? { syncCheckpoints } : {}),
      ...(defaultConversationId ? { defaultConversationId } : {}),
    });

    window.localStorage.removeItem(STORE_KEY);
    window.localStorage.removeItem(SYNC_CHECKPOINTS_KEY);
    window.localStorage.removeItem(DEFAULT_CONVERSATION_KEY);
    _cachedStore = null;
    _cacheRaw = null;
  })().catch((error) => {
    legacyMigrationPromise = null;
    throw error;
  });

  return legacyMigrationPromise;
};

export const getOrCreateLocalConversationId = async (): Promise<string> => {
  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      return await window.electronAPI!.localChat.getOrCreateDefaultConversationId();
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer default conversation ID:", (err as Error).message);
    }
  }

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

export const listLocalEvents = async (
  conversationId: string,
  maxItems = 200,
): Promise<EventRecord[]> => {
  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      return await window.electronAPI!.localChat.listEvents({
        conversationId,
        maxItems,
      });
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer transcript store:", (err as Error).message);
    }
  }

  return fallbackListLocalEvents(conversationId, maxItems);
};

export const getLocalEventCount = async (conversationId: string): Promise<number> => {
  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      return await window.electronAPI!.localChat.getEventCount({ conversationId });
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer transcript count:", (err as Error).message);
    }
  }

  return fallbackGetLocalEventCount(conversationId);
};

export const appendLocalEvent = async (args: LocalAppendEventArgs): Promise<EventRecord> => {
  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      return await window.electronAPI!.localChat.appendEvent(args);
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer transcript append:", (err as Error).message);
    }
  }

  return fallbackAppendLocalEvent(args);
};

/**
 * Build history messages using the same pipeline as the cloud/server-side path:
 * token-budgeted event selection, tool call/result formatting, and micro-compaction.
 *
 * Selection is token-budget-based (default 24 000 tokens, matching the backend).
 */
export const buildLocalHistoryMessages = async (
  conversationId: string,
): Promise<LocalHistoryMessage[]> => {
  const events = await listLocalEvents(conversationId, 800);
  const contextEvents = events.filter((event) => CONTEXT_EVENT_TYPES.has(event.type));
  if (contextEvents.length === 0) return [];

  const newestFirst = [...contextEvents].reverse();
  const selected = selectRecentByTokenBudget({
    itemsNewestFirst: newestFirst,
    maxTokens: DEFAULT_HISTORY_MAX_TOKENS,
    estimateTokens: (event) =>
      estimateContextEventTokens({
        type: event.type,
        payload: event.payload,
        requestId: event.requestId,
      }),
  });

  const chronological = [...selected].reverse();
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

export const buildLocalSyncMessages = async (
  conversationId: string,
  maxMessages = MAX_EVENTS_PER_CONVERSATION,
): Promise<LocalSyncMessage[]> => {
  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      return await window.electronAPI!.localChat.listSyncMessages({
        conversationId,
        maxMessages,
      });
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer sync message build:", (err as Error).message);
    }
  }

  return fallbackBuildLocalSyncMessages(conversationId, maxMessages);
};

export const getLocalSyncCheckpoint = async (conversationId: string): Promise<string | null> => {
  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      return await window.electronAPI!.localChat.getSyncCheckpoint({ conversationId });
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer sync checkpoint read:", (err as Error).message);
    }
  }

  const checkpoints = readSyncCheckpoints();
  const checkpoint = checkpoints[conversationId];
  return typeof checkpoint === "string" && checkpoint.length > 0 ? checkpoint : null;
};

export const setLocalSyncCheckpoint = async (conversationId: string, localMessageId: string) => {
  if (!conversationId || !localMessageId) return;

  if (hasElectronLocalChatApi()) {
    try {
      await migrateLegacyLocalStateToElectron();
      await window.electronAPI!.localChat.setSyncCheckpoint({
        conversationId,
        localMessageId,
      });
      return;
    } catch (err) {
      console.debug("[local-chat-store] Falling back to renderer sync checkpoint write:", (err as Error).message);
    }
  }

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

  const unsubscribeElectron = hasElectronLocalChatApi()
    ? window.electronAPI!.localChat.onUpdated(listener)
    : () => {};

  return () => {
    unsubscribeElectron();
    window.removeEventListener(UPDATE_EVENT_NAME, onCustomEvent);
    window.removeEventListener("storage", onStorage);
  };
};
