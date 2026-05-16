import type { TaskLifecycleStatus } from "../../contracts/agent-runtime.js";
import {
  MAX_ACTIVE_RUNTIME_THREADS,
  type RuntimeThreadRecord,
  normalizeRuntimeThreadId,
} from "../runtime-threads.js";
import type { SqliteDatabase } from "./shared.js";
import {
  listPendingOrchestratorReverts as listPendingOrchestratorRevertsImpl,
  listPendingOriginThreadReverts as listPendingOriginThreadRevertsImpl,
  markSelfModRevertsOrchestratorConsumed as markOrchestratorConsumedImpl,
  markSelfModRevertsOriginThreadConsumed as markOriginThreadConsumedImpl,
  recordSelfModRevert as recordSelfModRevertImpl,
  type SelfModRevertRecord,
} from "./self-mod-reverts.js";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  type LocalChatActivityWindow,
  type LocalChatAppendEventArgs,
  type LocalChatEventRecord,
  type LocalChatEventRow,
  type LocalChatMessageRecord,
  type LocalChatMessageWindow,
  type LocalChatSyncMessage,
  type TimelineCursor,
  type PersistedRuntimeThreadPayload,
  type RuntimeRunEvent,
  RUNTIME_THREAD_SESSION_VERSION,
  type RuntimeThreadCompactionEntry,
  type RuntimeThreadCustomMessageEntry,
  type RuntimeThreadMessageEntry,
  type RuntimeThreadSessionEntry,
  type RuntimeThreadMessage,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  eventTextFromPayload,
  generateLocalId,
  isUserContent,
  parseJsonRecord,
  parseRuntimeThreadPayload,
  toJsonString,
  toJsonValueString,
} from "./shared.js";
import {
  countVisibleChatMessageEvents,
  isUiHiddenChatMessagePayload,
  sliceEventsByVisibleMessageWindow,
  type LocalChatEventWindowMode,
} from "../../chat-event-visibility.js";
import { MemoryStore } from "../memory/memory-store.js";
import { ThreadSummariesStore } from "../memory/thread-summaries-store.js";

/**
 * Upper bound on the user/assistant rows scanned per `listMessages` /
 * `listMessagesBefore` call to compute the visible-message cutoff. Lets
 * the scan absorb hundreds of hidden system reminders / workspace
 * requests near the tail without scanning every row in chats with
 * millions of historical events.
 */
const CUTOFF_SCAN_CEILING = 4000;

type VisibleScanRow = {
  timestamp: number | null;
  id: string | null;
  payloadJson: string | null;
};

const compareTimelineCursor = (
  a: { timestamp: number; id: string },
  b: { timestamp: number; id: string },
): number => {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id.localeCompare(b.id);
};

const cursorFromVisibleScan = (
  rows: VisibleScanRow[],
  maxVisibleMessages: number,
): TimelineCursor => {
  let visible = 0;
  let oldestScanned: TimelineCursor = null;
  for (const row of rows) {
    if (typeof row.timestamp !== "number" || typeof row.id !== "string") {
      continue;
    }
    oldestScanned = { timestamp: row.timestamp, id: row.id };
    const payload = parseJsonRecord(row.payloadJson) ?? null;
    if (isUiHiddenChatMessagePayload(payload)) continue;
    visible += 1;
    if (visible === maxVisibleMessages) {
      return { timestamp: row.timestamp, id: row.id };
    }
  }
  return rows.length >= CUTOFF_SCAN_CEILING ? oldestScanned : null;
};

type SessionRow = {
  id: string;
  syncCheckpointMessageId: string | null;
};

type ThreadSessionRow = {
  sessionId: string;
  createdAt: number;
  cwd: string;
  parentSession: string | null;
};

type ThreadSessionEntryRow = {
  entryId: string;
  parentEntryId: string | null;
  entryType: string;
  timestampIso: string;
  createdAt: number;
  dataJson: string | null;
};

export type PersistedAgentRecord = {
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  agentDepth: number;
  maxAgentDepth?: number;
  parentAgentId?: string;
  selfModMetadata?: {
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update" | "uninstall";
  };
  status: TaskLifecycleStatus;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  updatedAt: number;
};

const parseJsonValue = <T>(value: string | null): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const eventRoleForType = (type: string): string => {
  switch (type) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "tool_request":
    case "tool_result":
      return "tool";
    default:
      return "system";
  }
};

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";

const toIsoTimestamp = (timestamp: number): string =>
  new Date(timestamp).toISOString();

const formatThreadCheckpointMessage = (summary: string): string =>
  [
    THREAD_CHECKPOINT_MARKER,
    "",
    summary.trim(),
  ].join("\n");

const previewFromTextAndImages = (
  content: Extract<PersistedRuntimeThreadPayload, { role: "user" | "toolResult" }>["content"] | RuntimeThreadCustomMessageEntry["content"],
): string => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[Image: ${block.mimeType}]`)
    .join("\n")
    .trim();
};

const previewFromAssistantPayload = (
  payload: Extract<PersistedRuntimeThreadPayload, { role: "assistant" }>,
): string =>
  payload.content
    .flatMap((block) => {
      if (block.type === "text") {
        return block.text.trim() ? [block.text] : [];
      }
      if (block.type === "toolCall") {
        return [
          `[Tool call] ${block.name}\nargs: ${JSON.stringify(block.arguments ?? {})}`,
        ];
      }
      return [];
    })
    .join("\n\n")
    .trim();

const previewFromPayload = (
  payload: PersistedRuntimeThreadPayload,
): string => {
  if (payload.role === "assistant") {
    return previewFromAssistantPayload(payload);
  }
  if (payload.role === "toolResult") {
    const body = previewFromTextAndImages(payload.content);
    return [
      `[Tool result] ${payload.toolName}`,
      ...(body ? [body] : []),
    ].join("\n").trim();
  }
  return previewFromTextAndImages(payload.content);
};

const buildFallbackThreadPayload = (
  message: RuntimeThreadMessage,
): PersistedRuntimeThreadPayload => {
  if (message.payload) {
    return message.payload;
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.trim().length > 0
        ? [{ type: "text", text: message.content }]
        : [],
      api: "openai-completions",
      provider: "stella",
      model: "history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId ?? "",
      toolName: "tool",
      content: message.content.trim().length > 0
        ? [{ type: "text", text: message.content }]
        : [],
      isError: false,
      timestamp: message.timestamp,
    };
  }
  return {
    role: "user",
    content: message.content,
    timestamp: message.timestamp,
  };
};

const rowSizeTextEncoder = new TextEncoder();
// Tool results that include a screenshot (vision content block) routinely
// run 1–2 MB once the PNG is base64-encoded — that's a normal payload, not
// pathological. The previous 1.8 MB cap was below that threshold, so every
// `stella-computer snapshot` result with an inline screenshot got dropped
// to a "too large to persist" placeholder, breaking the agent's context for
// the very next turn. SQLite handles multi-MB rows fine; bump high enough
// to fit a screenshot + element tree comfortably.
const THREAD_ROW_MAX_BYTES = 6_000_000;
const THREAD_ROW_MAX_TEXT_CHARS = 1_000;
const THREAD_ROW_PREVIEW_CHARS = 500;

const payloadByteLength = (payload: PersistedRuntimeThreadPayload): number =>
  rowSizeTextEncoder.encode(JSON.stringify(payload)).byteLength;

const customMessageByteLength = (
  message: Pick<
    RuntimeThreadCustomMessageEntry,
    "customType" | "content" | "display"
  >,
): number => rowSizeTextEncoder.encode(JSON.stringify(message)).byteLength;

const truncatePreview = (
  value: string,
  maxChars = THREAD_ROW_PREVIEW_CHARS,
): string => (value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`);

const truncateTextBlockForStorage = (
  text: string,
  label = "Text",
): string =>
  `[${label} truncated for storage (${text.length} chars). First ${Math.min(text.length, THREAD_ROW_PREVIEW_CHARS)} chars: ${truncatePreview(text)}]`;

const truncateToolOutputForStorage = (text: string): string =>
  `This tool output was too large to persist in storage (${text.length} chars). If the user asks about this data, suggest re-running the tool. Preview: ${truncatePreview(text)}`;

const truncateObjectForStorage = (
  value: unknown,
  label: string,
): Record<string, string> => {
  const json = JSON.stringify(value);
  return {
    __truncated: `${label} truncated for storage (${json.length} chars). Preview: ${truncatePreview(json)}`,
  };
};

const enforceThreadPayloadRowSizeLimit = (
  payload: PersistedRuntimeThreadPayload,
): PersistedRuntimeThreadPayload => {
  if (payloadByteLength(payload) <= THREAD_ROW_MAX_BYTES) {
    return payload;
  }

  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? truncateTextBlockForStorage(payload.content, "User content")
        : payload.content.map((block) =>
            block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS
              ? { ...block, text: truncateTextBlockForStorage(block.text, "User content") }
              : block,
          );
    const candidate = { ...payload, content };
    if (payloadByteLength(candidate) <= THREAD_ROW_MAX_BYTES) {
      return candidate;
    }
    return {
      ...payload,
      content:
        typeof payload.content === "string"
          ? truncateTextBlockForStorage(payload.content, "User content")
          : [{ type: "text", text: truncateTextBlockForStorage(JSON.stringify(payload.content), "User content") }],
    };
  }

  if (payload.role === "assistant") {
    const compacted = {
      ...payload,
      content: payload.content.map((block) => {
        if (block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS) {
          return { ...block, text: truncateTextBlockForStorage(block.text) };
        }
        if (block.type === "thinking" && block.thinking.length > THREAD_ROW_MAX_TEXT_CHARS) {
          return { ...block, thinking: truncateTextBlockForStorage(block.thinking, "Reasoning") };
        }
        if (block.type === "toolCall") {
          const argsJson = JSON.stringify(block.arguments ?? {});
          if (argsJson.length > THREAD_ROW_MAX_TEXT_CHARS) {
            return {
              ...block,
              arguments: truncateObjectForStorage(block.arguments ?? {}, `${block.name} arguments`),
            };
          }
        }
        return block;
      }),
    } satisfies PersistedRuntimeThreadPayload;
    if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
      return compacted;
    }
    return {
      ...payload,
      content: [
        {
          type: "text",
          text: truncateTextBlockForStorage(
            JSON.stringify(payload.content),
            "Assistant message",
          ),
        },
      ],
    };
  }

  const compacted = {
    ...payload,
    content: payload.content.map((block) =>
      block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS
        ? { ...block, text: truncateToolOutputForStorage(block.text) }
        : block,
    ),
  } satisfies PersistedRuntimeThreadPayload;
  if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }

  // Still too big — almost always because an inline image (vision content
  // block) ballooned the row. Drop the base64 payload of every image and
  // leave a small text breadcrumb in its place so the rest of the result
  // (and any other text blocks the model still needs) survives.
  const withoutImageData: PersistedRuntimeThreadPayload = {
    ...compacted,
    content: compacted.content.map((block) => {
      if (block.type !== "image") {
        return block;
      }
      const sizeKb = Math.round((block.data?.length ?? 0) * 0.75 / 1024);
      return {
        type: "text" as const,
        text: `[image content block stripped for storage: mime=${block.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
      };
    }),
  };
  if (payloadByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
    return withoutImageData;
  }

  return {
    ...payload,
    content: [{ type: "text", text: truncateToolOutputForStorage(JSON.stringify(payload.content)) }],
  };
};

const enforceCustomMessageRowSizeLimit = (
  message: Pick<
    RuntimeThreadCustomMessageEntry,
    "customType" | "content" | "display"
  >,
): Pick<
  RuntimeThreadCustomMessageEntry,
  "customType" | "content" | "display"
> => {
  if (customMessageByteLength(message) <= THREAD_ROW_MAX_BYTES) {
    return message;
  }

  const content =
    typeof message.content === "string"
      ? truncateTextBlockForStorage(message.content, "Custom message")
      : message.content.map((block) => {
          if (block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS) {
            return {
              ...block,
              text: truncateTextBlockForStorage(block.text, "Custom message"),
            };
          }
          return block;
        });
  const compacted = {
    ...message,
    content,
  };
  if (customMessageByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }

  const withoutImageData = {
    ...compacted,
    content: typeof compacted.content === "string"
      ? compacted.content
      : compacted.content.map((block) => {
          if (block.type !== "image") {
            return block;
          }
          const sizeKb = Math.round((block.data?.length ?? 0) * 0.75 / 1024);
          return {
            type: "text" as const,
            text: `[image content block stripped for storage: mime=${block.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
          };
        }),
  };
  if (customMessageByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
    return withoutImageData;
  }

  return {
    ...message,
    content:
      typeof message.content === "string"
        ? truncateTextBlockForStorage(message.content, "Custom message")
        : [{
            type: "text",
            text: truncateTextBlockForStorage(
              JSON.stringify(message.content),
              "Custom message",
            ),
          }],
  };
};

const parseThreadSessionEntry = (
  row: ThreadSessionEntryRow,
): RuntimeThreadSessionEntry | null => {
  const data = parseJsonValue<Record<string, unknown>>(row.dataJson);
  switch (row.entryType) {
    case "message": {
      const rawMessage =
        data && "message" in data
          ? parseRuntimeThreadPayload(
              JSON.stringify((data as { message?: unknown }).message),
            )
          : undefined;
      if (!rawMessage) {
        return null;
      }
      return {
        type: "message",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        message: rawMessage,
      } satisfies RuntimeThreadMessageEntry;
    }
    case "compaction": {
      const summary =
        typeof data?.summary === "string" ? data.summary.trim() : "";
      const fromEntryId =
        typeof data?.fromEntryId === "string"
          ? data.fromEntryId.trim()
          : "";
      const toEntryId =
        typeof data?.toEntryId === "string"
          ? data.toEntryId.trim()
          : "";
      const firstKeptEntryId =
        typeof data?.firstKeptEntryId === "string"
          ? data.firstKeptEntryId.trim()
          : "";
      const tokensBefore =
        typeof data?.tokensBefore === "number" && Number.isFinite(data.tokensBefore)
          ? data.tokensBefore
          : 0;
      if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
        return null;
      }
      return {
        type: "compaction",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        summary,
        ...(fromEntryId && toEntryId ? { fromEntryId, toEntryId } : {}),
        ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
        tokensBefore,
        ...(data && "details" in data ? { details: data.details } : {}),
        ...(data?.fromHook === true ? { fromHook: true } : {}),
      } satisfies RuntimeThreadCompactionEntry;
    }
    case "custom_message": {
      const customType =
        typeof data?.customType === "string" ? data.customType.trim() : "";
      const content = (data as { content?: unknown } | null)?.content;
      const display = data?.display === true;
      if (!customType || !isUserContent(content)) {
        return null;
      }
      return {
        type: "custom_message",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        customType,
        content,
        display,
      } satisfies RuntimeThreadCustomMessageEntry;
    }
    default:
      return null;
  }
};

const toThreadMessageRecord = (
  entry: RuntimeThreadSessionEntry,
): (RuntimeThreadMessage & { entryId: string }) | null => {
  if (entry.type === "message") {
    const payload = entry.message;
    return {
      entryId: entry.id,
      threadKey: "",
      timestamp: payload.timestamp,
      role: payload.role,
      content: previewFromPayload(payload),
      ...(payload.role === "toolResult"
        ? { toolCallId: payload.toolCallId }
        : {}),
      payload,
    };
  }
  if (entry.type === "custom_message") {
    return {
      entryId: entry.id,
      threadKey: "",
      timestamp: Date.parse(entry.timestamp) || Date.now(),
      role: "runtimeInternal",
      content: previewFromTextAndImages(entry.content),
      customMessage: {
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
      },
    };
  }
  return null;
};

type ThreadCompactionOverlay = {
  id: string;
  summary: string;
  fromEntryId: string;
  toEntryId: string;
  timestamp: number;
};

const buildThreadPathEntries = (
  entries: RuntimeThreadSessionEntry[],
): RuntimeThreadSessionEntry[] => {
  if (entries.length === 0) {
    return [];
  }
  const byId = new Map<string, RuntimeThreadSessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  let leaf: RuntimeThreadSessionEntry | undefined = entries[entries.length - 1];
  const path: RuntimeThreadSessionEntry[] = [];
  while (leaf) {
    path.unshift(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  return path;
};

const buildRawThreadMessages = (
  path: RuntimeThreadSessionEntry[],
): Array<RuntimeThreadMessage & { entryId: string }> =>
  path
    .map((entry) => toThreadMessageRecord(entry))
    .filter(
      (message): message is RuntimeThreadMessage & { entryId: string } =>
        message !== null,
    );

const normalizeCompactionOverlay = (
  compaction: RuntimeThreadCompactionEntry,
  rawMessages: Array<RuntimeThreadMessage & { entryId: string }>,
): ThreadCompactionOverlay | null => {
  const timestamp = Date.parse(compaction.timestamp) || Date.now();
  if (compaction.fromEntryId && compaction.toEntryId) {
    return {
      id: compaction.id,
      summary: compaction.summary,
      fromEntryId: compaction.fromEntryId,
      toEntryId: compaction.toEntryId,
      timestamp,
    };
  }
  if (!compaction.firstKeptEntryId) {
    return null;
  }
  const firstKeptIndex = rawMessages.findIndex(
    (message) => message.entryId === compaction.firstKeptEntryId,
  );
  if (firstKeptIndex <= 0) {
    return null;
  }
  const fromEntryId = rawMessages[0]?.entryId;
  const toEntryId = rawMessages[firstKeptIndex - 1]?.entryId;
  if (!fromEntryId || !toEntryId) {
    return null;
  }
  return {
    id: compaction.id,
    summary: compaction.summary,
    fromEntryId,
    toEntryId,
    timestamp,
  };
};

const buildThreadCompactionOverlays = (
  path: RuntimeThreadSessionEntry[],
  rawMessages: Array<RuntimeThreadMessage & { entryId: string }>,
): ThreadCompactionOverlay[] =>
  path
    .filter((entry): entry is RuntimeThreadCompactionEntry => entry.type === "compaction")
    .map((entry) => normalizeCompactionOverlay(entry, rawMessages))
    .filter((entry): entry is ThreadCompactionOverlay => entry !== null);

const applyCompactionOverlays = (
  rawMessages: Array<RuntimeThreadMessage & { entryId: string }>,
  overlays: ThreadCompactionOverlay[],
): Array<RuntimeThreadMessage & { entryId: string }> => {
  if (rawMessages.length === 0 || overlays.length === 0) {
    return rawMessages;
  }
  const ids = rawMessages.map((message) => message.entryId);
  const result: Array<RuntimeThreadMessage & { entryId: string }> = [];
  let index = 0;
  while (index < rawMessages.length) {
    const matching = overlays.filter((overlay) => overlay.fromEntryId === ids[index]);
    const overlay = matching.length > 1 ? matching[matching.length - 1] : matching[0];
    if (overlay) {
      const endIndex = ids.indexOf(overlay.toEntryId);
      if (endIndex >= index) {
        result.push({
          entryId: overlay.id,
          threadKey: "",
          timestamp: overlay.timestamp,
          role: "assistant",
          content: formatThreadCheckpointMessage(overlay.summary),
        });
        index = endIndex + 1;
        continue;
      }
    }
    result.push(rawMessages[index]!);
    index += 1;
  }
  return result;
};

const buildThreadMessagesFromEntries = (
  entries: RuntimeThreadSessionEntry[],
): Array<RuntimeThreadMessage & { entryId: string }> => {
  const path = buildThreadPathEntries(entries);
  const rawMessages = buildRawThreadMessages(path);
  const overlays = buildThreadCompactionOverlays(path, rawMessages);
  return applyCompactionOverlays(rawMessages, overlays);
};

export class SessionStore {
  private memoryStoreInstance: MemoryStore | null = null;
  private threadSummariesStoreInstance: ThreadSummariesStore | null = null;

  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Lazily-constructed singleton MemoryStore wrapping this store's database.
   * Snapshot capture is intentionally NOT performed here; callers decide when
   * to freeze a snapshot boundary for their own run/session.
   */
  get memoryStore(): MemoryStore {
    if (!this.memoryStoreInstance) {
      this.memoryStoreInstance = new MemoryStore(this.db);
    }
    return this.memoryStoreInstance;
  }

  /**
   * Lazily-constructed singleton ThreadSummariesStore. Stage 1 of the
   * Chronicle/Dream memory pipeline — receives one row per finalized
   * subagent run (see {@link finalizeSubagentSuccess}).
   */
  get threadSummariesStore(): ThreadSummariesStore {
    if (!this.threadSummariesStoreInstance) {
      this.threadSummariesStoreInstance = new ThreadSummariesStore(this.db);
    }
    return this.threadSummariesStoreInstance;
  }

  private withTransaction(work: () => void): void {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare(`
      SELECT value
      FROM settings
      WHERE key = ?
    `).get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.length > 0
      ? row.value
      : null;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  private sanitizeConversationId(value: unknown): string {
    const conversationId = asTrimmedString(value);
    if (!conversationId) {
      throw new Error("conversationId is required.");
    }
    return conversationId;
  }

  private upsertSession(sessionId: string, updatedAt: number): void {
    this.db.prepare(`
      INSERT INTO session (
        id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES (?, '', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = CASE
          WHEN excluded.updated_at > updated_at THEN excluded.updated_at
          ELSE updated_at
        END
    `).run(sessionId, updatedAt, updatedAt);
  }

  private getSession(sessionId: string): SessionRow | null {
    const row = this.db.prepare(`
      SELECT
        id,
        sync_checkpoint_message_id AS syncCheckpointMessageId
      FROM session
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  private deriveImplicitThreadMetadata(threadKey: string): {
    conversationId: string;
    agentType: string;
  } {
    const subagentMarker = "::subagent::";
    const subagentIndex = threadKey.indexOf(subagentMarker);
    if (subagentIndex > 0) {
      const conversationId = threadKey.slice(0, subagentIndex).trim();
      const remainder = threadKey.slice(subagentIndex + subagentMarker.length);
      const nextDelimiter = remainder.indexOf("::");
      const agentType = nextDelimiter > 0
        ? remainder.slice(0, nextDelimiter).trim()
        : "subagent";
      if (conversationId) {
        return {
          conversationId,
          agentType: agentType || "subagent",
        };
      }
    }

    return {
      conversationId: threadKey,
      agentType: "orchestrator",
    };
  }

  private ensureImplicitThreadRow(threadKey: string): {
    conversationId: string;
    agentType: string;
  } {
    const derived = this.deriveImplicitThreadMetadata(threadKey);
    const now = Date.now();
    this.upsertSession(derived.conversationId, now);
    this.db.prepare(`
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'evicted', ?, ?, NULL)
      ON CONFLICT(thread_key) DO NOTHING
    `).run(
      threadKey,
      derived.conversationId,
      derived.agentType,
      threadKey,
      now,
      now,
    );
    return derived;
  }

  private replaceMessageParts(messageId: string, sessionId: string, parts: Array<{
    type: string;
    toolCallId?: string;
    data: unknown;
    createdAt: number;
  }>): void {
    this.db.prepare(`
      DELETE FROM part
      WHERE message_id = ?
    `).run(messageId);
    const stmt = this.db.prepare(`
      INSERT INTO part (
        id,
        session_id,
        message_id,
        ord,
        type,
        tool_call_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    parts.forEach((part, index) => {
      stmt.run(
        `${messageId}:part:${index}`,
        sessionId,
        messageId,
        index,
        part.type,
        part.toolCallId ?? null,
        toJsonValueString(part.data),
        part.createdAt,
      );
    });
  }

  private upsertEventMessage(args: {
    sessionId: string;
    eventId: string;
    type: string;
    timestamp: number;
    deviceId?: string;
    requestId?: string;
    targetDeviceId?: string;
    payload?: Record<string, unknown>;
    channelEnvelope?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO message (
        id,
        session_id,
        thread_key,
        run_id,
        role,
        type,
        request_id,
        device_id,
        target_device_id,
        agent_type,
        data_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        role = excluded.role,
        type = excluded.type,
        request_id = excluded.request_id,
        device_id = excluded.device_id,
        target_device_id = excluded.target_device_id,
        data_json = excluded.data_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      args.eventId,
      args.sessionId,
      eventRoleForType(args.type),
      args.type,
      args.requestId ?? null,
      args.deviceId ?? null,
      args.targetDeviceId ?? null,
      toJsonString(
        args.channelEnvelope
          ? { channelEnvelope: args.channelEnvelope }
          : undefined,
      ),
      args.timestamp,
      args.timestamp,
    );
    this.replaceMessageParts(args.eventId, args.sessionId, args.payload
      ? [
          {
            type: "payload",
            data: args.payload,
            createdAt: args.timestamp,
          },
        ]
      : []);
  }

  private deserializeEventRow(row: LocalChatEventRow): LocalChatEventRecord {
    const meta = parseJsonRecord(row.channelEnvelopeJson);
    return {
      _id: row._id,
      timestamp: row.timestamp,
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(parseJsonRecord(row.payloadJson) ? { payload: parseJsonRecord(row.payloadJson)! } : {}),
      ...(asObject(meta?.channelEnvelope) ? { channelEnvelope: asObject(meta?.channelEnvelope)! } : {}),
    };
  }

  private listAllEventsForConversation(conversationId: string): LocalChatEventRecord[] {
    const rows = this.db.prepare(`
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type NOT IN ('thread_message', 'run_event', 'memory')
      ORDER BY message.created_at ASC, message.id ASC
    `).all(conversationId) as LocalChatEventRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const type = asTrimmedString(args.type);
    if (!type) {
      throw new Error("type is required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const eventId = asTrimmedString(args.eventId) || `local-${generateLocalId()}`;
    const payload = asObject(args.payload) ?? undefined;
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined;
    const deviceId = asTrimmedString(args.deviceId) || undefined;
    const requestId = asTrimmedString(args.requestId) || undefined;
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined;

    this.withTransaction(() => {
      this.upsertSession(conversationId, timestamp);
      this.upsertEventMessage({
        sessionId: conversationId,
        eventId,
        type,
        timestamp,
        deviceId,
        requestId,
        targetDeviceId,
        payload,
        channelEnvelope,
      });
    });

    return {
      _id: eventId,
      timestamp,
      type,
      ...(deviceId ? { deviceId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(targetDeviceId ? { targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(channelEnvelope ? { channelEnvelope } : {}),
    };
  }

  /**
   * Shallow-merge a partial payload into an existing local-chat event's
   * stored payload. Returns the updated record (so callers can fire
   * `notifyLocalChatUpdated`), or null when the event/payload row is
   * missing. Used by the worker to attach post-run fields like
   * `selfModApplied` onto the assistant message after the run finalizes.
   *
   * Atomicity: the SELECT, merge, and write all run inside a single
   * `withTransaction` block so a concurrent writer to the same eventId
   * can't slip a write between the read and the merge.
   *
   * Caveat: the write replaces every `part` row for the message via
   * `replaceMessageParts`, then re-inserts a single merged payload at
   * `ord: 0`. Today every chat event only stores its payload at ord 0,
   * but a future feature adding multi-part chat events would have its
   * non-ord:0 parts wiped by a subsequent `mergeEventPayload` call.
   * If that becomes a concern, switch to a part-level merge instead of
   * full replacement. The transaction below logs a tripwire warning
   * when it observes more than one existing part row for the target
   * message so we notice the moment a multi-part event type lands.
   */
  mergeEventPayload(args: {
    conversationId: string;
    eventId: string;
    patch: Record<string, unknown>;
  }): LocalChatEventRecord | null {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const eventId = asTrimmedString(args.eventId);
    if (!eventId) {
      return null;
    }
    let updatedRecord: LocalChatEventRecord | null = null;
    this.withTransaction(() => {
      const existingRow = this.db
        .prepare(`
          SELECT
            message.id AS _id,
            message.created_at AS timestamp,
            message.type AS type,
            message.device_id AS deviceId,
            message.request_id AS requestId,
            message.target_device_id AS targetDeviceId,
            part.data_json AS payloadJson,
            message.data_json AS channelEnvelopeJson
          FROM message
          LEFT JOIN part
            ON part.message_id = message.id
           AND part.ord = 0
          WHERE message.id = ?
            AND message.session_id = ?
        `)
        .get(eventId, conversationId) as LocalChatEventRow | undefined;
      if (!existingRow) {
        return;
      }
      // Tripwire: see JSDoc caveat. `replaceMessageParts` below is
      // destructive across all ords for this message id; if we ever
      // see >1 part row pre-merge it means a multi-part event type
      // has landed and this method silently dropped sibling parts.
      const existingPartCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM part WHERE message_id = ?`,
          )
          .get(eventId) as { n: number } | undefined
      )?.n ?? 0;
      if (existingPartCount > 1) {
        console.warn(
          `[session-store] mergeEventPayload destructively replaced ${existingPartCount} parts for event ${eventId} (conversation ${conversationId}); only ord:0 will survive. A multi-part event type now exists — switch this method to a part-level merge.`,
        );
      }
      const existingPayload = parseJsonRecord(existingRow.payloadJson) ?? {};
      const mergedPayload: Record<string, unknown> = {
        ...existingPayload,
        ...args.patch,
      };
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE message SET updated_at = ? WHERE id = ? AND session_id = ?`,
        )
        .run(now, eventId, conversationId);
      this.replaceMessageParts(eventId, conversationId, [
        {
          type: "payload",
          data: mergedPayload,
          createdAt: existingRow.timestamp,
        },
      ]);
      updatedRecord = {
        ...this.deserializeEventRow(existingRow),
        payload: mergedPayload,
      };
    });
    return updatedRecord;
  }

  getOrCreateDefaultConversationId(): string {
    const existing = this.getSetting(DEFAULT_CONVERSATION_SETTING_KEY);
    if (existing) {
      this.upsertSession(existing, Date.now());
      return existing;
    }

    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertSession(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
    });
    return created;
  }

  listEvents(
    conversationIdInput: string,
    maxItems = 200,
    windowMode: LocalChatEventWindowMode = "events",
  ): LocalChatEventRecord[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    if (windowMode === "visible_messages") {
      return sliceEventsByVisibleMessageWindow(
        this.listAllEventsForConversation(conversationId),
        maxItems,
      );
    }

    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.db.prepare(`
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `).all(conversationId, normalizedLimit) as LocalChatEventRow[];

    return rows.map((row) => this.deserializeEventRow(row));
  }

  /**
   * Page strictly older events than a `(beforeTimestampMs, beforeId)` cursor.
   * Used by the chat home overview's "See all" dialog to walk SQLite for
   * additional history beyond the renderer's in-memory event window —
   * without that, the dialog can only ever show what's already loaded for
   * the live chat (capped at ~500 events).
   *
   * Mirrors `listEvents`'s exclusion of internal types (`thread_message`,
   * `run_event`, `memory`) so the rows roundtrip through the same
   * `EventRecord` shape downstream consumers already use.
   */
  listEventsBefore(
    conversationIdInput: string,
    opts: {
      beforeTimestampMs: number;
      beforeId?: string;
      limit?: number;
    },
  ): LocalChatEventRecord[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const beforeTimestamp = Math.floor(opts.beforeTimestampMs);
    const beforeId = opts.beforeId ?? "";
    const normalizedLimit = Math.max(1, Math.floor(opts.limit ?? 50));
    const rows = this.db.prepare(`
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
          AND (
            created_at < ?
            OR (created_at = ? AND id < ?)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `).all(
      conversationId,
      beforeTimestamp,
      beforeTimestamp,
      beforeId,
      normalizedLimit,
    ) as LocalChatEventRow[];

    return rows.map((row) => this.deserializeEventRow(row));
  }

  /**
   * Window of visible chat messages with each assistant message's turn-
   * scoped tool/`agent-completed` events attached as `toolEvents`. This is
   * the read shape the chat UI consumes — pure event-log readers should
   * keep using `listEvents` / `listEventsBefore`.
   *
   * Two-step query: first locate the (timestamp, id) cutoff of the
   * `maxVisibleMessages`-th most-recent user/assistant row, then fetch all
   * tool/agent-completed events from the cutoff forward and group them by
   * turn (boundary = `user_message`). Mirrors the renderer's prior
   * `segmentToolEventsByAssistant` so the inline-artifact / askQuestion /
   * schedule-receipt projections that hung off the flat event stream keep
   * working without a flat event stream.
   *
   * `messages` is the ordered visible chat (oldest → newest). Trailing
   * tool/agent-completed events that landed after the last visible
   * `user_message` with no following assistant yet (typical for
   * fire-and-forget image submissions in-flight at fetch time) stay on
   * that user message's `toolEvents`, so the renderer can synthesize the
   * standalone artifact row it always has.
   */
  listMessages(
    conversationIdInput: string,
    args: {
      maxVisibleMessages?: number;
    } = {},
  ): LocalChatMessageWindow {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.floor(args.maxVisibleMessages ?? 200),
    );
    const cutoff = this.findVisibleMessageCutoff(
      conversationId,
      maxVisibleMessages,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchTimelineRows(conversationId, fetchCutoff, null);
    return this.trimMessageWindow(this.assembleMessageWindow(rows), cutoff);
  }

  /**
   * Same projection as `listMessages` but returns strictly-older messages
   * than `(beforeTimestampMs, beforeId)`. Drives the chat's "load older"
   * pagination — the cursor is the oldest message in the currently-loaded
   * window so successive calls walk the conversation backwards a page at
   * a time.
   */
  listMessagesBefore(
    conversationIdInput: string,
    args: {
      beforeTimestampMs: number;
      beforeId: string;
      maxVisibleMessages?: number;
    },
  ): LocalChatMessageWindow {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.floor(args.maxVisibleMessages ?? 200),
    );
    const beforeTimestamp = Math.floor(args.beforeTimestampMs);
    const beforeId = args.beforeId;
    const before = { timestamp: beforeTimestamp, id: beforeId };
    const cutoff = this.findVisibleMessageCutoffBefore(
      conversationId,
      maxVisibleMessages,
      before,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchTimelineRows(conversationId, fetchCutoff, before);
    return this.trimMessageWindow(this.assembleMessageWindow(rows), cutoff);
  }

  /**
   * Walks user/assistant rows DESC pulling the payload JSON so we can
   * skip UI-hidden messages (system reminders, workspace-creation
   * requests — see `isUiHiddenChatMessagePayload`). Without this, hidden
   * rows near the tail eat the `maxVisibleMessages` budget and the chat
   * surface comes back missing real messages.
   *
   * Bounded by `CUTOFF_SCAN_CEILING` — large enough to absorb the
   * worst-case hidden-row density observed in real chats but capped so
   * conversations with millions of events don't fetch them all to
   * compute a window cutoff. If the ceiling is hit before we find
   * `maxVisibleMessages` visible rows, the oldest scanned message becomes
   * the cutoff so the timeline read remains bounded.
   */
  private findVisibleMessageCutoff(
    conversationId: string,
    maxVisibleMessages: number,
  ): TimelineCursor {
    const rows = this.db.prepare(`
      SELECT message.created_at AS timestamp, message.id AS id, part.data_json AS payloadJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('user_message', 'assistant_message')
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT ?
    `).all(conversationId, CUTOFF_SCAN_CEILING) as VisibleScanRow[];
    return cursorFromVisibleScan(rows, maxVisibleMessages);
  }

  private findVisibleMessageCutoffBefore(
    conversationId: string,
    maxVisibleMessages: number,
    before: TimelineCursor & {},
  ): TimelineCursor {
    const rows = this.db.prepare(`
      SELECT message.created_at AS timestamp, message.id AS id, part.data_json AS payloadJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('user_message', 'assistant_message')
        AND (
          message.created_at < ?
          OR (message.created_at = ? AND message.id < ?)
        )
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT ?
    `).all(
      conversationId,
      before.timestamp,
      before.timestamp,
      before.id,
      CUTOFF_SCAN_CEILING,
    ) as VisibleScanRow[];
    return cursorFromVisibleScan(rows, maxVisibleMessages);
  }

  private fetchTimelineRows(
    conversationId: string,
    cutoff: TimelineCursor,
    before: TimelineCursor,
  ): LocalChatEventRecord[] {
    const clauses: string[] = [
      "message.session_id = ?",
      "message.type IN ('user_message', 'assistant_message', 'tool_request', 'tool_result', 'agent-completed')",
    ];
    const params: Array<string | number> = [conversationId];
    if (cutoff) {
      clauses.push("(message.created_at > ? OR (message.created_at = ? AND message.id >= ?))");
      params.push(cutoff.timestamp, cutoff.timestamp, cutoff.id);
    }
    if (before) {
      clauses.push("(message.created_at < ? OR (message.created_at = ? AND message.id < ?))");
      params.push(before.timestamp, before.timestamp, before.id);
    }
    const sql = `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE ${clauses.join(" AND ")}
      ORDER BY message.created_at ASC, message.id ASC
    `;
    const rows = this.db.prepare(sql).all(...params) as LocalChatEventRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  private findTurnFetchCutoff(
    conversationId: string,
    cutoff: TimelineCursor,
  ): TimelineCursor {
    if (!cutoff) return null;
    const row = this.db.prepare(`
      SELECT message.created_at AS timestamp, message.id AS id
      FROM message
      WHERE message.session_id = ?
        AND message.type = 'user_message'
        AND (
          message.created_at < ?
          OR (message.created_at = ? AND message.id <= ?)
        )
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT 1
    `).get(
      conversationId,
      cutoff.timestamp,
      cutoff.timestamp,
      cutoff.id,
    ) as { timestamp?: unknown; id?: unknown } | undefined;
    if (typeof row?.timestamp !== "number" || typeof row.id !== "string") {
      return cutoff;
    }
    return { timestamp: row.timestamp, id: row.id };
  }

  private trimMessageWindow(
    window: LocalChatMessageWindow,
    cutoff: TimelineCursor,
  ): LocalChatMessageWindow {
    if (!cutoff) return window;
    let visibleMessageCount = 0;
    const messages = window.messages.filter((message) => {
      const keep =
        compareTimelineCursor(
          { timestamp: message.timestamp, id: message._id },
          cutoff,
        ) >= 0;
      if (keep && !isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      return keep;
    });
    return { messages, visibleMessageCount };
  }

  /**
   * Walk fetched rows forward, group them into turns (boundary =
   * `user_message`), and attach every tool/`agent-completed` event in
   * a turn to its turn anchor:
   *
   *   - **first assistant** of the turn when one exists — preserves the
   *     prior `segmentToolEventsByAssistant` behavior so inline image,
   *     schedule receipt, office preview, and source-diff artifacts
   *     keep rendering against the assistant row even when the
   *     orchestrator calls the tool BEFORE its reply text (common for
   *     `image_gen` / `html` / `Schedule`);
   *
   *   - **user_message** of the turn when no assistant fires — fixes the
   *     prior port's silent drop of tools in turns where the agent's
   *     first action is `askQuestion`. The renderer's standalone-
   *     askQuestion bubble and trailing-image artifact paths already
   *     read from `user_message.toolEvents`, so they surface correctly.
   *
   * Secondary assistants in the same turn (agent terminal notices,
   * follow-up replies) come back with `toolEvents: []` — the row
   * pipeline still finds them in `messages` for streaming-text overlay
   * purposes, they just don't own the turn's artifacts.
   *
   * `visibleMessageCount` is the count of user/assistant rows whose
   * payload doesn't satisfy `isUiHiddenChatMessagePayload`. The chat
   * hook bases `hasOlderMessages` / `isLoadingOlder` on this rather
   * than raw `messages.length` so UI-hidden system reminders or
   * workspace-creation requests in the window don't make pagination
   * state latch against the wrong threshold.
   */
  private assembleMessageWindow(
    rows: LocalChatEventRecord[],
  ): LocalChatMessageWindow {
    const messages: LocalChatMessageRecord[] = [];
    let turnUserMessage: LocalChatMessageRecord | null = null;
    let firstAssistantInTurn: LocalChatMessageRecord | null = null;
    let toolsInTurn: LocalChatEventRecord[] = [];
    let visibleMessageCount = 0;

    const commitTurn = () => {
      const anchor = firstAssistantInTurn ?? turnUserMessage;
      if (anchor && toolsInTurn.length > 0) {
        anchor.toolEvents = toolsInTurn;
      }
      turnUserMessage = null;
      firstAssistantInTurn = null;
      toolsInTurn = [];
    };

    for (const row of rows) {
      if (row.type === "user_message") {
        commitTurn();
        const message: LocalChatMessageRecord = { ...row, toolEvents: [] };
        messages.push(message);
        turnUserMessage = message;
        if (!isUiHiddenChatMessagePayload(row.payload ?? null)) {
          visibleMessageCount += 1;
        }
        continue;
      }
      if (row.type === "assistant_message") {
        const message: LocalChatMessageRecord = { ...row, toolEvents: [] };
        messages.push(message);
        if (firstAssistantInTurn === null) {
          firstAssistantInTurn = message;
        }
        if (!isUiHiddenChatMessagePayload(row.payload ?? null)) {
          visibleMessageCount += 1;
        }
        continue;
      }
      toolsInTurn.push(row);
    }

    commitTurn();

    return { messages, visibleMessageCount };
  }

  /**
   * Agent lifecycle events (`agent-started` / `agent-progress` /
   * `agent-completed` / `agent-failed` / `agent-canceled`) for the
   * conversation, ordered ASC by `(timestamp, _id)`.
   *
   * Used by the activity surfaces (footer working indicator,
   * `ChatHomeOverview` Now/Done/UpNext, `ActivityHistoryDialog`) so they
   * no longer have to scan the full event stream looking for the handful
   * of rows that actually drive task state.
   *
   * `latestMessageTimestampMs` is the timestamp of the most recent
   * user/assistant message anywhere in the conversation (independent of
   * the activity cap). The stale-schedule auto-completion path needs to
   * know whether ANY user/assistant message arrived after a given task's
   * `startedAtMs`; surfacing one number here keeps that check intact
   * without dragging the message stream along.
   *
   * Optional `beforeTimestampMs` / `beforeId` cursor returns strictly-
   * older activity (used by `ActivityHistoryDialog` to page back through
   * Completed history). `latestMessageTimestampMs` stays global to the
   * conversation either way.
   */
  listActivity(
    conversationIdInput: string,
    args: {
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    } = {},
  ): LocalChatActivityWindow {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const before =
      typeof args.beforeTimestampMs === "number"
        ? {
            timestamp: Math.floor(args.beforeTimestampMs),
            id: args.beforeId ?? "",
          }
        : null;

    const clauses = [
      "session_id = ?",
      "type IN ('agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')",
    ];
    const params: Array<string | number> = [conversationId];
    if (before) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(before.timestamp, before.timestamp, before.id);
    }
    params.push(normalizedLimit);

    const rows = this.db.prepare(`
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `).all(...params) as LocalChatEventRow[];

    const activities = rows.map((row) => this.deserializeEventRow(row));

    const latestRow = this.db.prepare(`
      SELECT created_at AS timestamp
      FROM message
      WHERE session_id = ?
        AND type IN ('user_message', 'assistant_message')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as { timestamp?: unknown } | undefined;
    const latestMessageTimestampMs =
      typeof latestRow?.timestamp === "number" ? latestRow.timestamp : null;

    return { activities, latestMessageTimestampMs };
  }

  getEventCount(
    conversationIdInput: string,
    windowMode: LocalChatEventWindowMode = "events",
  ): number {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    if (windowMode === "visible_messages") {
      return countVisibleChatMessageEvents(
        this.listAllEventsForConversation(conversationId),
      );
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM message
      WHERE session_id = ?
        AND type NOT IN ('thread_message', 'run_event', 'memory')
    `).get(conversationId) as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  listSyncMessages(
    conversationIdInput: string,
    maxMessages = MAX_EVENTS_PER_CONVERSATION,
  ): LocalChatSyncMessage[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxMessages));
    const rows = this.db.prepare(`
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        part.data_json AS payloadJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type IN ('user_message', 'assistant_message')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `).all(conversationId, normalizedLimit) as Array<{
      _id: string;
      timestamp: number;
      type: string;
      deviceId: string | null;
      payloadJson: string | null;
    }>;

    const messages: LocalChatSyncMessage[] = [];
    for (const row of rows) {
      const payload = parseJsonRecord(row.payloadJson);
      const text = eventTextFromPayload(payload);
      if (!text) continue;
      const role = row.type === "user_message" ? "user" : "assistant";
      messages.push({
        localMessageId: row._id,
        role,
        text,
        timestamp: row.timestamp,
        ...(role === "user" && row.deviceId ? { deviceId: row.deviceId } : {}),
      });
    }
    return messages;
  }

  getSyncCheckpoint(conversationIdInput: string): string | null {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    return this.getSession(conversationId)?.syncCheckpointMessageId ?? null;
  }

  setSyncCheckpoint(conversationIdInput: string, localMessageIdInput: string): void {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const localMessageId = asTrimmedString(localMessageIdInput);
    if (!localMessageId) return;
    this.upsertSession(conversationId, Date.now());
    this.db.prepare(`
      UPDATE session
      SET sync_checkpoint_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(localMessageId, Date.now(), conversationId);
  }

  private getThreadConversationId(threadKey: string): string {
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { conversationId?: unknown } | undefined;
    if (typeof row?.conversationId === "string" && row.conversationId.trim().length > 0) {
      return row.conversationId;
    }
    return this.ensureImplicitThreadRow(threadKey).conversationId;
  }

  private getThreadSession(threadKey: string): ThreadSessionRow | null {
    const row = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        created_at AS createdAt,
        cwd,
        parent_session AS parentSession
      FROM runtime_thread_sessions
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as ThreadSessionRow | undefined;
    return row ?? null;
  }

  private ensureThreadSession(
    threadKey: string,
    conversationId: string,
    timestamp: number,
  ): ThreadSessionRow {
    const existing = this.getThreadSession(threadKey);
    if (existing) {
      this.db.prepare(`
        UPDATE runtime_thread_sessions
        SET updated_at = ?
        WHERE thread_key = ?
      `).run(timestamp, threadKey);
      return existing;
    }

    const sessionId = generateLocalId();
    const cwd = "";
    this.upsertSession(conversationId, timestamp);
    this.db.prepare(`
      INSERT INTO runtime_thread_sessions (
        thread_key,
        session_id,
        version,
        cwd,
        parent_session,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `).run(
      threadKey,
      sessionId,
      RUNTIME_THREAD_SESSION_VERSION,
      cwd,
      timestamp,
      timestamp,
    );
    return {
      sessionId,
      createdAt: timestamp,
      cwd,
      parentSession: null,
    };
  }

  private getThreadLeafEntryId(threadKey: string): string | null {
    const row = this.db.prepare(`
      SELECT entry_id AS entryId
      FROM runtime_thread_entries
      WHERE thread_key = ?
      ORDER BY created_at DESC, entry_id DESC
      LIMIT 1
    `).get(threadKey) as { entryId?: unknown } | undefined;
    return typeof row?.entryId === "string" && row.entryId.trim().length > 0
      ? row.entryId
      : null;
  }

  private appendThreadSessionEntry(args: {
    threadKey: string;
    sessionId: string;
    entryType: RuntimeThreadSessionEntry["type"];
    timestamp: number;
    data: Record<string, unknown>;
  }): string {
    const entryId = generateLocalId();
    const parentEntryId = this.getThreadLeafEntryId(args.threadKey);
    const timestampIso = toIsoTimestamp(args.timestamp);
    this.db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id,
        thread_key,
        session_id,
        parent_entry_id,
        entry_type,
        timestamp_iso,
        created_at,
        data_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      args.threadKey,
      args.sessionId,
      parentEntryId,
      args.entryType,
      timestampIso,
      args.timestamp,
      toJsonValueString(args.data),
    );
    return entryId;
  }

  private loadThreadSessionEntries(
    threadKey: string,
    limit?: number,
  ): RuntimeThreadSessionEntry[] {
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT
        recent.entry_id AS entryId,
        recent.parent_entry_id AS parentEntryId,
        recent.entry_type AS entryType,
        recent.timestamp_iso AS timestampIso,
        recent.created_at AS createdAt,
        recent.data_json AS dataJson
      FROM (
        SELECT *
        FROM runtime_thread_entries
        WHERE thread_key = ?
        ORDER BY created_at DESC, entry_id DESC
        ${normalizedLimit ? "LIMIT ?" : ""}
      ) recent
      ORDER BY recent.created_at ASC, recent.entry_id ASC
    `;
    const rows = (
      normalizedLimit
        ? this.db.prepare(sql).all(threadKey, normalizedLimit)
        : this.db.prepare(sql).all(threadKey)
    ) as ThreadSessionEntryRow[];
    return rows
      .map((row) => parseThreadSessionEntry(row))
      .filter((entry): entry is RuntimeThreadSessionEntry => entry !== null);
  }

  appendThreadMessage(message: RuntimeThreadMessage): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    const payload = enforceThreadPayloadRowSizeLimit(
      buildFallbackThreadPayload(message),
    );
    this.withTransaction(() => {
      this.upsertSession(conversationId, message.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        message.timestamp,
      );
      this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "message",
        timestamp: message.timestamp,
        data: {
          message: payload,
        },
      });
      this.touchThread(threadKey);
    });
  }

  appendThreadCustomMessage(message: {
    threadKey: string;
    timestamp: number;
    customType: string;
    content: RuntimeThreadCustomMessageEntry["content"];
    display: boolean;
  }): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const customType = message.customType.trim();
    if (!customType) {
      throw new Error("customType is required.");
    }
    const boundedMessage = enforceCustomMessageRowSizeLimit({
      customType,
      content: message.content,
      display: message.display,
    });
    const conversationId = this.getThreadConversationId(threadKey);
    this.withTransaction(() => {
      this.upsertSession(conversationId, message.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        message.timestamp,
      );
      this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "custom_message",
        timestamp: message.timestamp,
        data: {
          customType: boundedMessage.customType,
          content: boundedMessage.content,
          display: boundedMessage.display,
        },
      });
      this.touchThread(threadKey);
    });
  }

  loadThreadMessages(
    threadKeyInput: string,
    limit?: number,
  ): Array<{
    entryId?: string;
    timestamp: number;
    role: RuntimeThreadMessage["role"];
    content: string;
    toolCallId?: string;
    payload?: RuntimeThreadMessage["payload"];
    customMessage?: RuntimeThreadMessage["customMessage"];
  }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    return buildThreadMessagesFromEntries(
      this.loadThreadSessionEntries(threadKey, limit),
    ).map((message) => ({
      ...(message.entryId ? { entryId: message.entryId } : {}),
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
      ...(message.customMessage ? { customMessage: message.customMessage } : {}),
    }));
  }

  compactThread(args: {
    threadKey: string;
    summary: string;
    fromEntryId?: string;
    toEntryId?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    timestamp?: number;
    details?: unknown;
    fromHook?: boolean;
  }): void {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const summary = args.summary.trim();
    const fromEntryId = args.fromEntryId?.trim();
    const toEntryId = args.toEntryId?.trim();
    const firstKeptEntryId = args.firstKeptEntryId?.trim();
    if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
      throw new Error("summary and a compaction range are required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const conversationId = this.getThreadConversationId(threadKey);
    this.withTransaction(() => {
      const path = buildThreadPathEntries(this.loadThreadSessionEntries(threadKey));
      const rawMessages = buildRawThreadMessages(path);
      const existingOverlays = buildThreadCompactionOverlays(path, rawMessages);
      const normalizedFromEntryId =
        existingOverlays[0]?.fromEntryId ?? fromEntryId;
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        timestamp,
      );
      this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "compaction",
        timestamp,
        data: {
          summary,
          ...(normalizedFromEntryId && toEntryId
            ? {
                fromEntryId: normalizedFromEntryId,
                toEntryId,
              }
            : {}),
          ...(normalizedFromEntryId || toEntryId ? {} : { firstKeptEntryId }),
          tokensBefore: Math.max(0, Math.floor(args.tokensBefore)),
          ...(args.details !== undefined ? { details: args.details } : {}),
          ...(args.fromHook ? { fromHook: true } : {}),
        },
      });
      this.touchThread(threadKey);
    });
  }

  recordRunEvent(event: RuntimeRunEvent): void {
    const messageId = `run:${event.runId}:${event.seq ?? generateLocalId()}`;
    this.withTransaction(() => {
      this.upsertSession(event.conversationId, event.timestamp);
      this.db.prepare(`
        INSERT INTO message (
          id,
          session_id,
          thread_key,
          run_id,
          role,
          type,
          request_id,
          device_id,
          target_device_id,
          agent_type,
          data_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, NULL, ?, 'system', 'run_event', NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          data_json = excluded.data_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        messageId,
        event.conversationId,
        event.runId,
        event.agentType,
        toJsonString({
          eventType: event.type,
          ...(event.seq == null ? {} : { seq: event.seq }),
        }),
        event.timestamp,
        event.timestamp,
      );
      this.replaceMessageParts(messageId, event.conversationId, [
        {
          type: "run_event",
          toolCallId: event.toolCallId,
          data: event,
          createdAt: event.timestamp,
        },
      ]);
    });
  }

  private deserializeRuntimeThread(row: {
    threadId: string;
    conversationId: string;
    name: string;
    agentType: string;
    status: "active" | "evicted";
    createdAt: number;
    lastUsedAt: number;
    description: string | null;
    summary: string | null;
  }): RuntimeThreadRecord {
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      name: row.name,
      agentType: row.agentType,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.description ? { description: row.description } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
    };
  }

  listActiveThreads(conversationId: string): RuntimeThreadRecord[] {
    const rows = this.db.prepare(`
      SELECT
        thread_key AS threadId,
        runtime_threads.conversation_id AS conversationId,
        name,
        runtime_threads.agent_type AS agentType,
        runtime_threads.status AS status,
        created_at AS createdAt,
        last_used_at AS lastUsedAt,
        runtime_threads.summary AS summary,
        runtime_agents.description AS description
      FROM runtime_threads
      LEFT JOIN runtime_agents
        ON runtime_agents.thread_id = runtime_threads.thread_key
      WHERE runtime_threads.conversation_id = ?
        AND runtime_threads.status = 'active'
      ORDER BY runtime_threads.last_used_at DESC
      LIMIT ?
    `).all(conversationId, MAX_ACTIVE_RUNTIME_THREADS) as Array<{
      threadId: string;
      conversationId: string;
      name: string;
      agentType: string;
      status: "active" | "evicted";
      createdAt: number;
      lastUsedAt: number;
      description: string | null;
      summary: string | null;
    }>;
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }

  resolveOrCreateActiveThread(args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
  }): { threadId: string; reused: boolean } {
    const requestedThreadId = normalizeRuntimeThreadId(args.threadId ?? "");
    const existing = requestedThreadId
      ? this.db.prepare(`
        SELECT
          thread_key AS threadId,
          conversation_id AS conversationId,
          agent_type AS agentType,
          status,
          created_at AS createdAt,
          last_used_at AS lastUsedAt,
          summary
        FROM runtime_threads
        WHERE thread_key = ?
        LIMIT 1
      `).get(requestedThreadId) as {
        threadId: string;
        conversationId: string;
        agentType: string;
        status: "active" | "evicted";
        createdAt: number;
        lastUsedAt: number;
        summary: string | null;
      } | undefined
      : undefined;

    if (existing) {
      if (
        existing.conversationId !== args.conversationId ||
        existing.agentType !== args.agentType
      ) {
        throw new Error(`Thread ${existing.threadId} belongs to a different conversation or agent type.`);
      }
      const activeThreads = this.listActiveThreads(args.conversationId);
      if (
        existing.status !== "active" &&
        activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS
      ) {
        const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (oldest) {
          this.db.prepare(`
            UPDATE runtime_threads
            SET status = 'evicted'
            WHERE thread_key = ?
          `).run(oldest.threadId);
        }
      }
      if (existing.status !== "active") {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'active'
          WHERE thread_key = ?
        `).run(existing.threadId);
      }
      this.touchThread(existing.threadId);
      return {
        threadId: existing.threadId,
        reused: true,
      };
    }

    const activeThreads = this.listActiveThreads(args.conversationId);
    if (activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS) {
      const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'evicted'
          WHERE thread_key = ?
        `).run(oldest.threadId);
      }
    }

    const prefix = "task-";
    const rows = this.db.prepare(`
      SELECT thread_key AS threadId
      FROM runtime_threads
      WHERE agent_type = ?
    `).all(args.agentType) as Array<{ threadId: string }>;
    let nextOrdinal = 1;
    for (const row of rows) {
      if (!row.threadId.startsWith(prefix)) continue;
      const suffix = Number.parseInt(row.threadId.slice(prefix.length), 10);
      if (Number.isFinite(suffix) && suffix >= nextOrdinal) {
        nextOrdinal = suffix + 1;
      }
    }
    const threadId = requestedThreadId || `${prefix}${nextOrdinal}`;
    const now = Date.now();
    this.upsertSession(args.conversationId, now);
    this.db.prepare(`
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
    `).run(
      threadId,
      args.conversationId,
      args.agentType,
      threadId,
      now,
      now,
    );
    return {
      threadId,
      reused: false,
    };
  }

  touchThread(threadKey: string): void {
    this.db.prepare(`
      UPDATE runtime_threads
      SET last_used_at = ?
      WHERE thread_key = ?
    `).run(Date.now(), threadKey);
  }

  getThreadExternalSessionId(threadKey: string): string | undefined {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db.prepare(`
      SELECT external_session_id AS externalSessionId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { externalSessionId?: unknown } | undefined;
    return typeof row?.externalSessionId === "string" &&
      row.externalSessionId.trim().length > 0
      ? row.externalSessionId.trim()
      : undefined;
  }

  setThreadExternalSessionId(
    threadKey: string,
    externalSessionId: string | null | undefined,
  ): void {
    this.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof externalSessionId === "string" && externalSessionId.trim().length > 0
        ? externalSessionId.trim()
        : null;
    this.db.prepare(`
      UPDATE runtime_threads
      SET external_session_id = ?, last_used_at = ?
      WHERE thread_key = ?
    `).run(normalized, Date.now(), threadKey);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { conversationId?: unknown } | undefined;
    this.db.prepare(`
      UPDATE runtime_threads
      SET summary = ?, last_used_at = ?
      WHERE thread_key = ?
    `).run(trimmed, Date.now(), threadKey);
    if (typeof row?.conversationId === "string" && row.conversationId.length > 0) {
      this.forceOrchestratorReminderOnNextTurn(row.conversationId);
    }
  }

  getThreadName(threadKey: string): string | undefined {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db.prepare(`
      SELECT name
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { name?: unknown } | undefined;
    return typeof row?.name === "string" && row.name.length > 0 ? row.name : undefined;
  }

  saveAgentRecord(record: PersistedAgentRecord): void {
    this.upsertSession(record.conversationId, record.updatedAt);
    this.db.prepare(`
      INSERT INTO runtime_agents (
        thread_id,
        conversation_id,
        agent_type,
        description,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        self_mod_metadata_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        agent_type = excluded.agent_type,
        description = excluded.description,
        agent_depth = excluded.agent_depth,
        max_agent_depth = excluded.max_agent_depth,
        parent_agent_id = excluded.parent_agent_id,
        self_mod_metadata_json = excluded.self_mod_metadata_json,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      record.threadId,
      record.conversationId,
      record.agentType,
      record.description,
      record.agentDepth,
      record.maxAgentDepth ?? null,
      record.parentAgentId ?? null,
      toJsonValueString(record.selfModMetadata) ?? null,
      record.status,
      record.startedAt,
      record.completedAt ?? null,
      record.result ?? null,
      record.error ?? null,
      record.updatedAt,
    );
  }

  getAgentRecord(threadId: string): PersistedAgentRecord | null {
    const row = this.db.prepare(`
      SELECT
        thread_id,
        conversation_id,
        agent_type,
        description,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        self_mod_metadata_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at
      FROM runtime_agents
      WHERE thread_id = ?
      LIMIT 1
    `).get(threadId) as
      | {
          thread_id: string;
          conversation_id: string;
          agent_type: string;
          description: string;
          agent_depth: number;
          max_agent_depth: number | null;
          parent_agent_id: string | null;
          self_mod_metadata_json: string | null;
          status: PersistedAgentRecord["status"];
          started_at: number;
          completed_at: number | null;
          result: string | null;
          error: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const selfModMetadata = parseJsonValue<PersistedAgentRecord["selfModMetadata"]>(
      row.self_mod_metadata_json,
    );
    return {
      threadId: row.thread_id,
      conversationId: row.conversation_id,
      agentType: row.agent_type,
      description: row.description,
      agentDepth: row.agent_depth,
      ...(row.max_agent_depth == null ? {} : { maxAgentDepth: row.max_agent_depth }),
      ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
      ...(selfModMetadata ? { selfModMetadata } : {}),
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updated_at,
    };
  }

  getOrchestratorReminderState(conversationId: string): {
    shouldInjectDynamicReminder: boolean;
    reminderTokensSinceLastInjection: number;
  } {
    const row = this.db.prepare(`
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as {
      reminderTokensSinceLastInjection?: unknown;
      forceReminderOnNextTurn?: unknown;
    } | undefined;
    const current = typeof row?.reminderTokensSinceLastInjection === "number"
      ? Math.max(0, Math.floor(row.reminderTokensSinceLastInjection))
      : 0;
    const shouldInjectDynamicReminder = row?.forceReminderOnNextTurn === 1;
    return {
      shouldInjectDynamicReminder,
      reminderTokensSinceLastInjection: current,
    };
  }

  updateOrchestratorReminderCounter(args: {
    conversationId: string;
    resetTo?: number;
    incrementBy?: number;
  }): void {
    const currentState = this.db.prepare(`
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(args.conversationId) as {
      reminderTokensSinceLastInjection?: unknown;
      forceReminderOnNextTurn?: unknown;
    } | undefined;
    const current =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    const nextValue = args.resetTo != null
      ? Math.max(0, Math.floor(args.resetTo))
      : Math.max(0, Math.floor(current + (args.incrementBy ?? 0)));
    const forceReminderOnNextTurn = args.resetTo != null
      ? 0
      : currentState?.forceReminderOnNextTurn === 1
        ? 1
        : 0;
    this.db.prepare(`
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = excluded.force_reminder_on_next_turn
    `).run(args.conversationId, nextValue, forceReminderOnNextTurn);
  }

  forceOrchestratorReminderOnNextTurn(conversationId: string): void {
    const currentState = this.db.prepare(`
      SELECT reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { reminderTokensSinceLastInjection?: unknown } | undefined;
    const reminderTokensSinceLastInjection =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    this.db.prepare(`
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = 1
    `).run(conversationId, reminderTokensSinceLastInjection);
  }

  /**
   * Increment the memory-review user-turn counter for the given conversation
   * and return the new value. Caller is responsible for gating on
   * `uiVisibility !== "hidden"` so that synthetic task-callback turns do not
   * inflate the count.
   */
  incrementUserTurnsSinceMemoryReview(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT user_turns_since_review AS userTurnsSinceReview
      FROM runtime_memory_review_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { userTurnsSinceReview?: unknown } | undefined;
    const current = typeof row?.userTurnsSinceReview === "number"
      ? Math.max(0, Math.floor(row.userTurnsSinceReview))
      : 0;
    const next = current + 1;
    this.db.prepare(`
      INSERT INTO runtime_memory_review_state (
        conversation_id,
        user_turns_since_review,
        last_review_at
      )
      VALUES (?, ?, NULL)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_turns_since_review = excluded.user_turns_since_review
    `).run(conversationId, next);
    return next;
  }

  /**
   * Reset the memory-review user-turn counter to zero and stamp the time of
   * the review. Call after a memory review fires so a quick second turn does
   * not double-trigger.
   */
  resetUserTurnsSinceMemoryReview(conversationId: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runtime_memory_review_state (
        conversation_id,
        user_turns_since_review,
        last_review_at
      )
      VALUES (?, 0, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_turns_since_review = 0,
        last_review_at = excluded.last_review_at
    `).run(conversationId, now);
  }

  /**
   * Increment the memory-injection user-turn counter for the given
   * conversation and return the new value. Caller is responsible for gating
   * on `uiVisibility !== "hidden"` so that synthetic task-callback turns do
   * not inflate the count. Used by prepareOrchestratorRun to decide whether
   * the next orchestrator turn should re-inject the memory bundle (every N
   * user turns) instead of paying for it on every single turn.
   */
  incrementUserTurnsSinceMemoryInjection(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT user_turns_since_injection AS userTurnsSinceInjection
      FROM runtime_memory_injection_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { userTurnsSinceInjection?: unknown } | undefined;
    const current = typeof row?.userTurnsSinceInjection === "number"
      ? Math.max(0, Math.floor(row.userTurnsSinceInjection))
      : 0;
    const next = current + 1;
    this.db.prepare(`
      INSERT INTO runtime_memory_injection_state (
        conversation_id,
        user_turns_since_injection
      )
      VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_turns_since_injection = excluded.user_turns_since_injection
    `).run(conversationId, next);
    return next;
  }

  /**
   * Reset the memory-injection user-turn counter to one. Call this on the
   * exact turn that just (re)injected the memory bundle so the count is "1
   * turn since injection" going into the next turn — keeps the existing
   * 40-turn cadence consistent across both the cold-start case (counter was
   * already 1) and the every-N-turn case (counter rolled past the
   * threshold).
   */
  resetUserTurnsSinceMemoryInjection(conversationId: string): void {
    this.db.prepare(`
      INSERT INTO runtime_memory_injection_state (
        conversation_id,
        user_turns_since_injection
      )
      VALUES (?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_turns_since_injection = 1
    `).run(conversationId);
  }

  /**
   * Append a row to the self-mod revert ledger. Called from the worker's
   * `INTERNAL_WORKER_SELF_MOD_REVERT` handler after a successful git
   * revert; the revert-notice hook drains pending rows on the next
   * `before_user_message` for the conversation (orchestrator slot) and
   * for the originating subagent (origin-thread slot) when the
   * orchestrator resumes it.
   */
  recordSelfModRevert(args: {
    conversationId: string;
    originThreadKey?: string | null;
    featureId: string;
    files: string[];
    revertedAt?: number;
  }): SelfModRevertRecord {
    return recordSelfModRevertImpl(this.db, args);
  }

  /** Pending reverts for the orchestrator's next user turn, oldest first. */
  listPendingOrchestratorReverts(
    conversationId: string,
  ): SelfModRevertRecord[] {
    return listPendingOrchestratorRevertsImpl(this.db, conversationId);
  }

  /**
   * Pending reverts whose originating thread key matches the given
   * `threadKey`. Used when a resumable subagent's `before_user_message`
   * fires — if its threadKey matches, the same subagent that did the
   * work sees the reminder on resume.
   */
  listPendingOriginThreadReverts(
    originThreadKey: string,
  ): SelfModRevertRecord[] {
    return listPendingOriginThreadRevertsImpl(this.db, originThreadKey);
  }

  /** Mark the orchestrator slot consumed for these revert ids. */
  markSelfModRevertsOrchestratorConsumed(revertIds: string[]): void {
    markOrchestratorConsumedImpl(this.db, revertIds);
  }

  /** Mark the origin-thread slot consumed for these revert ids. */
  markSelfModRevertsOriginThreadConsumed(revertIds: string[]): void {
    markOriginThreadConsumedImpl(this.db, revertIds);
  }

  /**
   * Read the per-conversation chronicle injection watermark. Returns the
   * largest mtime (in epoch ms) we've already injected for each window;
   * the caller compares against the file's current mtime to decide
   * whether the chronicle has rolled forward since the last injection.
   * Missing row => `{ tenMinMtimeMs: 0, sixHourMtimeMs: 0 }` so a first
   * injection always fires once the file exists.
   */
  getChronicleInjectionWatermark(conversationId: string): {
    tenMinMtimeMs: number;
    sixHourMtimeMs: number;
  } {
    const row = this.db.prepare(`
      SELECT last_10m_mtime_ms AS tenMinMtimeMs,
             last_6h_mtime_ms AS sixHourMtimeMs
      FROM runtime_chronicle_injection_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as
      | { tenMinMtimeMs?: unknown; sixHourMtimeMs?: unknown }
      | undefined;
    return {
      tenMinMtimeMs:
        typeof row?.tenMinMtimeMs === "number" && row.tenMinMtimeMs > 0
          ? row.tenMinMtimeMs
          : 0,
      sixHourMtimeMs:
        typeof row?.sixHourMtimeMs === "number" && row.sixHourMtimeMs > 0
          ? row.sixHourMtimeMs
          : 0,
    };
  }

  /**
   * Advance the chronicle injection watermark for one or both windows.
   * Pass only the windows that were actually injected on this turn — the
   * other window keeps its existing watermark so a single window roll
   * doesn't silently mark the other as "already injected".
   */
  updateChronicleInjectionWatermark(
    conversationId: string,
    args: { tenMinMtimeMs?: number; sixHourMtimeMs?: number },
  ): void {
    const existing = this.getChronicleInjectionWatermark(conversationId);
    const nextTenMin =
      typeof args.tenMinMtimeMs === "number" && args.tenMinMtimeMs > 0
        ? args.tenMinMtimeMs
        : existing.tenMinMtimeMs;
    const nextSixHour =
      typeof args.sixHourMtimeMs === "number" && args.sixHourMtimeMs > 0
        ? args.sixHourMtimeMs
        : existing.sixHourMtimeMs;
    this.db.prepare(`
      INSERT INTO runtime_chronicle_injection_state (
        conversation_id,
        last_10m_mtime_ms,
        last_6h_mtime_ms
      )
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_10m_mtime_ms = excluded.last_10m_mtime_ms,
        last_6h_mtime_ms = excluded.last_6h_mtime_ms
    `).run(conversationId, nextTenMin, nextSixHour);
  }

  /**
   * Increment the home-suggestions refresh counter (one tick per successful
   * General-agent finalize for this conversation) and return the new value.
   * The cheap-LLM refresh fires when the counter crosses its threshold; the
   * caller is responsible for resetting via
   * {@link resetGeneralFinalizesSinceHomeSuggestionsRefresh}.
   */
  incrementGeneralFinalizesSinceHomeSuggestionsRefresh(
    conversationId: string,
  ): number {
    const row = this.db.prepare(`
      SELECT finalizes_since_refresh AS finalizesSinceRefresh
      FROM runtime_home_suggestions_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { finalizesSinceRefresh?: unknown } | undefined;
    const current = typeof row?.finalizesSinceRefresh === "number"
      ? Math.max(0, Math.floor(row.finalizesSinceRefresh))
      : 0;
    const next = current + 1;
    this.db.prepare(`
      INSERT INTO runtime_home_suggestions_state (
        conversation_id,
        finalizes_since_refresh,
        last_refresh_at
      )
      VALUES (?, ?, NULL)
      ON CONFLICT(conversation_id) DO UPDATE SET
        finalizes_since_refresh = excluded.finalizes_since_refresh
    `).run(conversationId, next);
    return next;
  }

  /**
   * Reset the home-suggestions counter to zero and stamp the last refresh
   * time. Call after kicking off a refresh so a quick follow-up finalize
   * does not double-trigger.
   */
  resetGeneralFinalizesSinceHomeSuggestionsRefresh(
    conversationId: string,
  ): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runtime_home_suggestions_state (
        conversation_id,
        finalizes_since_refresh,
        last_refresh_at
      )
      VALUES (?, 0, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        finalizes_since_refresh = 0,
        last_refresh_at = excluded.last_refresh_at
    `).run(conversationId, now);
  }
}
