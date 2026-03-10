import crypto from "crypto";

export type LocalChatEventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: Record<string, unknown>;
};

export type LocalChatAppendEventArgs = {
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

export type LocalChatSyncMessage = {
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  deviceId?: string;
};

export type RuntimeThreadMessage = {
  timestamp: number;
  threadKey: string;
  role: "user" | "assistant";
  content: string;
  toolCallId?: string;
};

export type RuntimeRunEvent = {
  timestamp: number;
  runId: string;
  conversationId: string;
  agentType: string;
  seq?: number;
  type: "run_start" | "stream" | "tool_start" | "tool_end" | "error" | "run_end";
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  selfModApplied?: {
    featureId: string;
    files: string[];
    batchIndex: number;
  };
};

export type RuntimeSelfModApplied = NonNullable<RuntimeRunEvent["selfModApplied"]>;

export type RuntimeMemory = {
  timestamp: number;
  conversationId: string;
  content: string;
  tags?: string[];
};

export type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export type LocalChatEventRow = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId: string | null;
  requestId: string | null;
  targetDeviceId: string | null;
  payloadJson: string | null;
  channelEnvelopeJson: string | null;
};

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const MAX_EVENTS_PER_CONVERSATION = 2000;
export const DEFAULT_CONVERSATION_SETTING_KEY = "default_conversation_id";
export const MAX_RECALL_RESULTS = 8;
export const SQLITE_MEMORY_SCAN_LIMIT = 400;

export const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

export const fileSafeId = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_");

const encodeBase32 = (value: number, length: number): string => {
  let remaining = Math.floor(value);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = ULID_ALPHABET[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
};

export const generateLocalId = (): string => {
  const time = encodeBase32(Date.now(), 10);
  const bytes = crypto.randomBytes(16);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart += ULID_ALPHABET[bytes[index]! % ULID_ALPHABET.length];
  }
  return `${time}${randomPart}`;
};

export const toJsonString = (value: unknown): string | null => {
  const record = asObject(value);
  if (!record) return null;
  try {
    return JSON.stringify(record);
  } catch {
    return null;
  }
};

export const parseJsonRecord = (value: string | null): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return asObject(parsed) ?? undefined;
  } catch {
    return undefined;
  }
};

export const parseRuntimeSelfModApplied = (
  value: string | null,
): RuntimeSelfModApplied | undefined => {
  const record = parseJsonRecord(value);
  if (!record) return undefined;
  const featureId = typeof record.featureId === "string" ? record.featureId.trim() : "";
  const batchIndex = typeof record.batchIndex === "number" && Number.isFinite(record.batchIndex)
    ? Math.floor(record.batchIndex)
    : null;
  const files = Array.isArray(record.files)
    ? record.files.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  if (!featureId || batchIndex == null || files.length === 0) {
    return undefined;
  }
  return {
    featureId,
    files,
    batchIndex,
  };
};

export const eventTextFromPayload = (payload?: Record<string, unknown>): string => {
  const text = payload?.contextText ?? payload?.text;
  return typeof text === "string" ? text.trim() : "";
};

export const escapeSqlLike = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

export const toJsonTags = (tags?: string[]): string | null => {
  if (!tags || tags.length === 0) return null;
  const cleaned = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
};

export const parseJsonTags = (value: string | null): string[] | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const tags = parsed.filter((entry): entry is string => typeof entry === "string");
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
};

export const scoreMemoryMatches = (
  query: string,
  rows: RuntimeMemory[],
): Array<{ row: RuntimeMemory; score: number }> => {
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  return rows
    .map((row) => {
      const haystack = `${row.content} ${(row.tags ?? []).join(" ")}`.toLowerCase();
      const score = haystack.includes(query)
        ? 2
        : tokens.reduce((acc, token) => (haystack.includes(token) ? acc + 1 : acc), 0);
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.row.timestamp - a.row.timestamp;
    });
};
