import crypto from "crypto";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../../ai/types.js";

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

/**
 * Read shape backing `SessionStore.listMessages` — the same fields as
 * `LocalChatEventRecord` plus the turn-scoped `toolEvents` projection.
 * Renderer-facing contract lives at `runtime/contracts/local-chat.ts`
 * (`MessageRecord`); this is the storage-side mirror so callers in the
 * worker can construct one without depending on the contracts module.
 */
export type LocalChatMessageRecord = LocalChatEventRecord & {
  toolEvents: LocalChatEventRecord[];
};

export type LocalChatMessageWindow = {
  messages: LocalChatMessageRecord[];
  /**
   * Count of user/assistant entries in `messages` whose payload is not
   * UI-hidden (see `isUiHiddenChatMessagePayload`). The chat hook bases
   * pagination state on this rather than raw `messages.length` so hidden
   * system reminders / workspace-creation requests don't keep
   * `hasOlderMessages` / `isLoadingOlder` stuck against the wrong
   * threshold.
   */
  visibleMessageCount: number;
};

/** `(timestamp, id)` cursor used to page chat messages. `null` means
 *  "no cursor" (start at the beginning of the conversation). */
export type TimelineCursor = { timestamp: number; id: string } | null;

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

export type PersistedRuntimeThreadPayload =
  | UserMessage
  | AssistantMessage
  | Omit<ToolResultMessage, "details">;

export const RUNTIME_THREAD_SESSION_VERSION = 3;

export type RuntimeThreadSessionHeader = {
  type: "session";
  version: typeof RUNTIME_THREAD_SESSION_VERSION;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

export type RuntimeThreadSessionEntryBase = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type RuntimeThreadMessageEntry = RuntimeThreadSessionEntryBase & {
  type: "message";
  message: PersistedRuntimeThreadPayload;
};

export type RuntimeThreadThinkingLevelChangeEntry =
  RuntimeThreadSessionEntryBase & {
    type: "thinking_level_change";
    thinkingLevel: string;
  };

export type RuntimeThreadModelChangeEntry = RuntimeThreadSessionEntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};

export type RuntimeThreadCompactionEntry = RuntimeThreadSessionEntryBase & {
  type: "compaction";
  summary: string;
  fromEntryId?: string;
  toEntryId?: string;
  firstKeptEntryId?: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
};

export type RuntimeThreadBranchSummaryEntry =
  RuntimeThreadSessionEntryBase & {
    type: "branch_summary";
    fromId: string;
    summary: string;
    details?: unknown;
    fromHook?: boolean;
  };

export type RuntimeThreadCustomEntry = RuntimeThreadSessionEntryBase & {
  type: "custom";
  customType: string;
  data?: unknown;
};

export type RuntimeThreadCustomMessageEntry =
  RuntimeThreadSessionEntryBase & {
    type: "custom_message";
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
  };

export type RuntimeThreadLabelEntry = RuntimeThreadSessionEntryBase & {
  type: "label";
  targetId: string;
  label?: string;
};

export type RuntimeThreadSessionInfoEntry = RuntimeThreadSessionEntryBase & {
  type: "session_info";
  name?: string;
};

export type RuntimeThreadSessionEntry =
  | RuntimeThreadMessageEntry
  | RuntimeThreadThinkingLevelChangeEntry
  | RuntimeThreadModelChangeEntry
  | RuntimeThreadCompactionEntry
  | RuntimeThreadBranchSummaryEntry
  | RuntimeThreadCustomEntry
  | RuntimeThreadCustomMessageEntry
  | RuntimeThreadLabelEntry
  | RuntimeThreadSessionInfoEntry;

export type RuntimeThreadSessionFileEntry =
  | RuntimeThreadSessionHeader
  | RuntimeThreadSessionEntry;

export type RuntimeThreadMessage = {
  timestamp: number;
  threadKey: string;
  role: "user" | "assistant" | "toolResult" | "runtimeInternal";
  content: string;
  toolCallId?: string;
  payload?: PersistedRuntimeThreadPayload;
  customMessage?: Pick<
    RuntimeThreadCustomMessageEntry,
    "customType" | "content" | "display"
  >;
};

export type RuntimeRunEvent = {
  timestamp: number;
  runId: string;
  conversationId: string;
  agentType: string;
  seq?: number;
  type:
    | "run_start"
    | "stream"
    | "tool_start"
    | "tool_end"
    | "error"
    | "interrupted"
    | "run_end";
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

export const toJsonValueString = (value: unknown): string | null => {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
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

const isTextContent = (value: unknown): value is TextContent =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "text" &&
      typeof (value as { text?: unknown }).text === "string",
  );

const isImageContent = (value: unknown): value is ImageContent =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "image" &&
      typeof (value as { data?: unknown }).data === "string" &&
      typeof (value as { mimeType?: unknown }).mimeType === "string",
  );

const isThinkingContent = (value: unknown): value is ThinkingContent =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "thinking" &&
      typeof (value as { thinking?: unknown }).thinking === "string",
  );

const isToolCall = (value: unknown): value is ToolCall =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "toolCall" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { arguments?: unknown }).arguments === "object" &&
      (value as { arguments?: unknown }).arguments !== null &&
      !Array.isArray((value as { arguments?: unknown }).arguments),
  );

export const isUserContent = (
  value: unknown,
): value is string | (TextContent | ImageContent)[] =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every((entry) => isTextContent(entry) || isImageContent(entry)));

const isAssistantContent = (
  value: unknown,
): value is (TextContent | ThinkingContent | ToolCall)[] =>
  Array.isArray(value) &&
  value.every((entry) => isTextContent(entry) || isThinkingContent(entry) || isToolCall(entry));

const isToolResultContent = (
  value: unknown,
): value is (TextContent | ImageContent)[] =>
  Array.isArray(value) &&
  value.every((entry) => isTextContent(entry) || isImageContent(entry));

const isUsage = (value: unknown): value is Usage => {
  const record = asObject(value);
  const cost = asObject(record?.cost);
  return Boolean(
    record &&
      typeof record.input === "number" &&
      typeof record.output === "number" &&
      typeof record.cacheRead === "number" &&
      typeof record.cacheWrite === "number" &&
      typeof record.totalTokens === "number" &&
      cost &&
      typeof cost.input === "number" &&
      typeof cost.output === "number" &&
      typeof cost.cacheRead === "number" &&
      typeof cost.cacheWrite === "number" &&
      typeof cost.total === "number",
  );
};

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStopReason = (
  value: unknown,
): value is AssistantMessage["stopReason"] =>
  value === "stop" ||
  value === "length" ||
  value === "toolUse" ||
  value === "error" ||
  value === "aborted";

// Reconstructor strategy: validate the shape of fields the runtime currently
// reads (role, content, timestamps, usage, etc.) so callers can rely on those
// being well-typed, but pass through any *unlisted* extras unchanged so future
// fields added to AssistantMessage / ToolResultMessage / UserMessage survive a
// round-trip without an edit here. The previous strict reconstructor silently
// dropped unknown fields, which made adding e.g. cache-control or reasoning
// metadata a multi-file change.
//
// The known-key arrays below are linked to the source-of-truth types via a
// `satisfies (keyof X)[]` annotation. When `UserMessage` /
// `AssistantMessage` / `ToolResultMessage` add or remove fields, the
// compiler errors here until the array is updated — which prevents the
// passthrough path from drifting into "implicitly accept anything." Only
// fields the parser explicitly validates above need to land in these
// arrays; any genuinely new field that isn't yet validated (e.g. a future
// `cacheControl` on AssistantMessage) is preserved through the
// `collectUnknownExtras` passthrough until validation is added.
const KNOWN_USER_KEYS_LIST = [
  "role",
  "content",
  "timestamp",
] as const satisfies readonly (keyof UserMessage)[];
const KNOWN_USER_KEYS: ReadonlySet<string> = new Set(KNOWN_USER_KEYS_LIST);

const KNOWN_ASSISTANT_KEYS_LIST = [
  "role",
  "content",
  "api",
  "provider",
  "model",
  "usage",
  "stopReason",
  "timestamp",
  "responseId",
  "errorMessage",
] as const satisfies readonly (keyof AssistantMessage)[];
const KNOWN_ASSISTANT_KEYS: ReadonlySet<string> = new Set(
  KNOWN_ASSISTANT_KEYS_LIST,
);

const KNOWN_TOOL_RESULT_KEYS_LIST = [
  "role",
  "toolCallId",
  "toolName",
  "isError",
  "content",
  "timestamp",
] as const satisfies readonly (keyof Omit<ToolResultMessage, "details">)[];
const KNOWN_TOOL_RESULT_KEYS: ReadonlySet<string> = new Set(
  KNOWN_TOOL_RESULT_KEYS_LIST,
);

/**
 * Type-erased index signature for the unlisted fields preserved by
 * `parseRuntimeThreadPayload`. The discriminated union
 * `PersistedRuntimeThreadPayload` doesn't have an index signature
 * (each branch is a closed object type), so the only way to splice
 * future-added fields back into the round trip is to widen the
 * returned object to "this branch + arbitrary unlisted keys" via a
 * cast at the boundary. Naming the partial shape makes the cast
 * narrower than a flat `as unknown as PersistedRuntimeThreadPayload`:
 * the spread can't smuggle in a field whose value type is not
 * `unknown`-compatible (e.g. a function — JSON.parse can't produce
 * one, but the type system shouldn't have to know that).
 */
type ThreadPayloadExtras = { readonly [key: string]: unknown };

const collectUnknownExtras = (
  record: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): ThreadPayloadExtras => {
  const extras: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(record)) {
    if (knownKeys.has(key)) continue;
    extras[key] = value;
  }
  return extras;
};

export const parseRuntimeThreadPayload = (
  value: string | null,
): PersistedRuntimeThreadPayload | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.role === "user" &&
      isUserContent(record.content) &&
      isFiniteTimestamp(record.timestamp)
    ) {
      return {
        ...collectUnknownExtras(record, KNOWN_USER_KEYS),
        role: "user",
        content: record.content,
        timestamp: record.timestamp,
      } as unknown as PersistedRuntimeThreadPayload;
    }
    if (
      record.role === "assistant" &&
      isAssistantContent(record.content) &&
      typeof record.api === "string" &&
      typeof record.provider === "string" &&
      typeof record.model === "string" &&
      isUsage(record.usage) &&
      isStopReason(record.stopReason) &&
      isFiniteTimestamp(record.timestamp)
    ) {
      return {
        ...collectUnknownExtras(record, KNOWN_ASSISTANT_KEYS),
        role: "assistant",
        content: record.content,
        api: record.api,
        provider: record.provider,
        model: record.model,
        usage: record.usage,
        stopReason: record.stopReason,
        timestamp: record.timestamp,
        ...(typeof record.responseId === "string" && record.responseId.trim()
          ? { responseId: record.responseId }
          : {}),
        ...(typeof record.errorMessage === "string" && record.errorMessage.trim()
          ? { errorMessage: record.errorMessage }
          : {}),
      } as unknown as PersistedRuntimeThreadPayload;
    }
    if (
      record.role === "toolResult" &&
      typeof record.toolCallId === "string" &&
      typeof record.toolName === "string" &&
      typeof record.isError === "boolean" &&
      isToolResultContent(record.content) &&
      isFiniteTimestamp(record.timestamp)
    ) {
      return {
        ...collectUnknownExtras(record, KNOWN_TOOL_RESULT_KEYS),
        role: "toolResult",
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        isError: record.isError,
        content: record.content,
        timestamp: record.timestamp,
      } as unknown as PersistedRuntimeThreadPayload;
    }
    return undefined;
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
