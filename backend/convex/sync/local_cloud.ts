import { mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { v, type Infer, type Value } from "convex/values";
import { requireUserId } from "../auth";
import {
  jsonObjectValidator,
  optionalChannelEnvelopeValidator,
} from "../shared_validators";

type SyncTableName =
  | "conversations"
  | "events"
  | "attachments"
  | "tasks"
  | "threads"
  | "thread_messages"
  | "memories"
  | "memory_extraction_batches"
  | "heartbeat_configs"
  | "cron_jobs"
  | "usage_logs"
  | "self_mod_features"
  | "store_installs"
  | "canvas_states"
  | "user_preferences";

type OptionalChannelEnvelope = Infer<typeof optionalChannelEnvelopeValidator>;

type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronPayload =
  | {
      kind: "systemEvent";
      text: string;
      agentType?: string;
      deliver?: boolean;
    }
  | {
      kind: "agentTurn";
      message: string;
      agentType?: string;
      deliver?: boolean;
      includeHistory?: boolean;
    };

const syncTableValidator = v.union(
  v.literal("conversations"),
  v.literal("events"),
  v.literal("attachments"),
  v.literal("tasks"),
  v.literal("threads"),
  v.literal("thread_messages"),
  v.literal("memories"),
  v.literal("memory_extraction_batches"),
  v.literal("heartbeat_configs"),
  v.literal("cron_jobs"),
  v.literal("usage_logs"),
  v.literal("self_mod_features"),
  v.literal("store_installs"),
  v.literal("canvas_states"),
  v.literal("user_preferences"),
);

const syncUpsertItemValidator = v.object({
  table: syncTableValidator,
  localId: v.string(),
  row: jsonObjectValidator,
});

const syncDeleteItemValidator = v.object({
  table: syncTableValidator,
  localId: v.string(),
});

const syncSuccessItemValidator = v.object({
  table: syncTableValidator,
  localId: v.string(),
  remoteId: v.optional(v.string()),
});

const syncErrorItemValidator = v.object({
  table: syncTableValidator,
  localId: v.string(),
  message: v.string(),
});

const syncGateStatusValidator = v.object({
  enabled: v.boolean(),
  has247: v.boolean(),
  hasConnector: v.boolean(),
  connectedProviders: v.array(v.string()),
});

const LOCAL_SYNC_MAP_PREFIX = "local_sync_map";
const RUNTIME_MODE_KEY = "runtime_mode";
const ACTIVE_BRIDGE_STATUSES = new Set([
  "connected",
  "awaiting_auth",
  "initializing",
  "running",
]);

const mappingPreferenceKey = (table: SyncTableName, localId: string) =>
  `${LOCAL_SYNC_MAP_PREFIX}:${table}:${localId}`;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
};

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
};

const asArray = <T = unknown>(value: unknown): T[] | undefined =>
  Array.isArray(value) ? (value as T[]) : undefined;

const ensureString = (row: Record<string, unknown>, key: string): string => {
  const value = asString(row[key]);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }
  return value;
};

const ensureNumber = (row: Record<string, unknown>, key: string): number => {
  const value = asNumber(row[key]);
  if (value === undefined) {
    throw new Error(`Missing required field: ${key}`);
  }
  return value;
};

const parseChannelEnvelope = (value: unknown): OptionalChannelEnvelope => {
  const record = asRecord(value);
  if (!record) return undefined;
  const provider = asString(record.provider);
  const kind = asString(record.kind);
  if (!provider || !kind) return undefined;
  return record as OptionalChannelEnvelope;
};

const parseCronSchedule = (value: unknown): CronSchedule => {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Invalid cron schedule");
  }

  const kind = asString(record.kind);
  if (kind === "at") {
    const atMs = asNumber(record.atMs);
    if (atMs === undefined) {
      throw new Error("Invalid cron schedule: atMs required");
    }
    return { kind, atMs };
  }

  if (kind === "every") {
    const everyMs = asNumber(record.everyMs);
    if (everyMs === undefined) {
      throw new Error("Invalid cron schedule: everyMs required");
    }
    const anchorMs = asNumber(record.anchorMs);
    return anchorMs === undefined
      ? { kind, everyMs }
      : { kind, everyMs, anchorMs };
  }

  if (kind === "cron") {
    const expr = asString(record.expr);
    if (!expr) {
      throw new Error("Invalid cron schedule: expr required");
    }
    const tz = asString(record.tz);
    return tz ? { kind, expr, tz } : { kind, expr };
  }

  throw new Error("Invalid cron schedule kind");
};

const parseCronPayload = (value: unknown): CronPayload => {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Invalid cron payload");
  }

  const kind = asString(record.kind);
  if (kind === "systemEvent") {
    const text = asString(record.text);
    if (!text) {
      throw new Error("Invalid cron payload: text required");
    }
    const agentType = asString(record.agentType);
    const deliver = asBoolean(record.deliver);
    return {
      kind,
      text,
      ...(agentType ? { agentType } : {}),
      ...(deliver !== undefined ? { deliver } : {}),
    };
  }

  if (kind === "agentTurn") {
    const message = asString(record.message);
    if (!message) {
      throw new Error("Invalid cron payload: message required");
    }
    const agentType = asString(record.agentType);
    const deliver = asBoolean(record.deliver);
    const includeHistory = asBoolean(record.includeHistory);
    return {
      kind,
      message,
      ...(agentType ? { agentType } : {}),
      ...(deliver !== undefined ? { deliver } : {}),
      ...(includeHistory !== undefined ? { includeHistory } : {}),
    };
  }

  throw new Error("Invalid cron payload kind");
};

const getMapping = async (
  ctx: MutationCtx,
  ownerId: string,
  table: SyncTableName,
  localId: string,
): Promise<string | null> => {
  const pref = await ctx.db
    .query("user_preferences")
    .withIndex("by_owner_key", (q) =>
      q.eq("ownerId", ownerId).eq("key", mappingPreferenceKey(table, localId)),
    )
    .first();
  return pref?.value ?? null;
};

const setMapping = async (
  ctx: MutationCtx,
  ownerId: string,
  table: SyncTableName,
  localId: string,
  remoteId: string,
) => {
  const key = mappingPreferenceKey(table, localId);
  const existing = await ctx.db
    .query("user_preferences")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .first();
  const updatedAt = Date.now();

  if (existing) {
    await ctx.db.patch(existing._id, { value: remoteId, updatedAt });
    return;
  }

  await ctx.db.insert("user_preferences", {
    ownerId,
    key,
    value: remoteId,
    updatedAt,
  });
};

const clearMapping = async (
  ctx: MutationCtx,
  ownerId: string,
  table: SyncTableName,
  localId: string,
) => {
  const existing = await ctx.db
    .query("user_preferences")
    .withIndex("by_owner_key", (q) =>
      q.eq("ownerId", ownerId).eq("key", mappingPreferenceKey(table, localId)),
    )
    .first();
  if (existing) {
    await ctx.db.delete(existing._id);
  }
};

const getMappedId = async <T extends SyncTableName>(
  ctx: MutationCtx,
  ownerId: string,
  table: SyncTableName,
  localId: string,
): Promise<Id<T> | null> => {
  const value = await getMapping(ctx, ownerId, table, localId);
  return value ? (value as Id<T>) : null;
};

const resolveConversationId = async (
  ctx: MutationCtx,
  ownerId: string,
  row: Record<string, unknown>,
) => {
  const conversationLocalId = ensureString(row, "conversationLocalId");
  const conversationId = await getMappedId<"conversations">(
    ctx,
    ownerId,
    "conversations",
    conversationLocalId,
  );
  if (!conversationId) {
    throw new Error(
      `Missing conversation mapping for local id ${conversationLocalId}`,
    );
  }
  return conversationId;
};

const parseTaskStatusUpdates = (value: unknown) => {
  const rows = asArray<Record<string, unknown>>(value);
  if (!rows) return undefined;
  const parsed = rows
    .map((entry) => {
      const text = asString(entry?.text);
      const timestamp = asNumber(entry?.timestamp);
      if (!text || timestamp === undefined) return null;
      return { text, timestamp };
    })
    .filter((entry): entry is { text: string; timestamp: number } => entry !== null);
  return parsed.length > 0 ? parsed : undefined;
};

const parseMemorySnapshot = async (
  ctx: MutationCtx,
  ownerId: string,
  value: unknown,
) => {
  const rows = asArray<Record<string, unknown>>(value) ?? [];
  const parsed: Array<{ content: string; memoryId?: Id<"memories"> }> = [];
  for (const row of rows) {
    const content = asString(row?.content);
    if (!content) continue;
    const memoryLocalId = asString(row?.memoryId);
    let memoryId: Id<"memories"> | undefined;
    if (memoryLocalId) {
      memoryId = await getMappedId<"memories">(
        ctx,
        ownerId,
        "memories",
        memoryLocalId,
      ) ?? undefined;
    }
    parsed.push(memoryId ? { content, memoryId } : { content });
  }
  return parsed;
};

const upsertConversations = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId =
    await getMappedId<"conversations">(ctx, ownerId, "conversations", localId);
  const patch = {
    ownerId,
    title: asString(row.title),
    isDefault: asBoolean(row.isDefault) ?? false,
    createdAt: ensureNumber(row, "createdAt"),
    updatedAt: ensureNumber(row, "updatedAt"),
    tokenCount: asNumber(row.tokenCount),
    lastIngestedAt: asNumber(row.lastIngestedAt),
    lastExtractionAt: asNumber(row.lastExtractionAt),
    lastExtractionTokenCount: asNumber(row.lastExtractionTokenCount),
  };

  if (existingId) {
    await ctx.db.patch(existingId, patch);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("conversations", patch);
  return String(createdId);
};

const upsertEvents = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"events">(ctx, ownerId, "events", localId);
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const channelEnvelope = parseChannelEnvelope(row.channelEnvelope);
  const payload = (row.payload ?? {}) as Value;
  const data = {
    conversationId,
    timestamp: ensureNumber(row, "timestamp"),
    type: ensureString(row, "type"),
    deviceId: asString(row.deviceId),
    requestId: asString(row.requestId),
    targetDeviceId: asString(row.targetDeviceId),
    payload,
    channelEnvelope,
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("events", data);
  return String(createdId);
};

const upsertAttachments = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId =
    await getMappedId<"attachments">(ctx, ownerId, "attachments", localId);
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const data = {
    conversationId,
    deviceId: ensureString(row, "deviceId"),
    storageKey: ensureString(row, "storageKey"),
    url: asString(row.url),
    mimeType: ensureString(row, "mimeType"),
    size: ensureNumber(row, "size"),
    createdAt: ensureNumber(row, "createdAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("attachments", data);
  return String(createdId);
};

const upsertTasks = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"tasks">(ctx, ownerId, "tasks", localId);
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const parentTaskLocalId = asString(row.parentTaskLocalId);
  const parentTaskId = parentTaskLocalId
    ? await getMappedId<"tasks">(ctx, ownerId, "tasks", parentTaskLocalId)
    : null;
  const data = {
    conversationId,
    parentTaskId: parentTaskId ?? undefined,
    description: ensureString(row, "description"),
    prompt: ensureString(row, "prompt"),
    agentType: ensureString(row, "agentType"),
    status: ensureString(row, "status"),
    taskDepth: ensureNumber(row, "taskDepth"),
    model: asString(row.model),
    commandId: asString(row.commandId),
    result: asString(row.result),
    error: asString(row.error),
    statusUpdates: parseTaskStatusUpdates(row.statusUpdates),
    createdAt: ensureNumber(row, "createdAt"),
    updatedAt: ensureNumber(row, "updatedAt"),
    completedAt: asNumber(row.completedAt),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("tasks", data);
  return String(createdId);
};

const upsertThreads = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId =
    await getMappedId<"threads">(ctx, ownerId, "threads", localId);
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const data = {
    conversationId,
    name: ensureString(row, "name"),
    status: ensureString(row, "status"),
    summary: asString(row.summary),
    messageCount: ensureNumber(row, "messageCount"),
    totalTokenEstimate: ensureNumber(row, "totalTokenEstimate"),
    createdAt: ensureNumber(row, "createdAt"),
    lastUsedAt: ensureNumber(row, "lastUsedAt"),
    resurfacedAt: asNumber(row.resurfacedAt),
    closedAt: asNumber(row.closedAt),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("threads", data);
  return String(createdId);
};

const upsertThreadMessages = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"thread_messages">(
    ctx,
    ownerId,
    "thread_messages",
    localId,
  );
  const threadLocalId = ensureString(row, "threadLocalId");
  const threadId = await getMappedId<"threads">(
    ctx,
    ownerId,
    "threads",
    threadLocalId,
  );
  if (!threadId) {
    throw new Error(`Missing thread mapping for local id ${threadLocalId}`);
  }
  const data = {
    threadId,
    ordinal: ensureNumber(row, "ordinal"),
    role: ensureString(row, "role"),
    content: ensureString(row, "content"),
    toolCallId: asString(row.toolCallId),
    tokenEstimate: asNumber(row.tokenEstimate),
    createdAt: ensureNumber(row, "createdAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("thread_messages", data);
  return String(createdId);
};

const upsertMemories = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId =
    await getMappedId<"memories">(ctx, ownerId, "memories", localId);
  const conversationLocalId = asString(row.conversationLocalId);
  const conversationId = conversationLocalId
    ? await getMappedId<"conversations">(
        ctx,
        ownerId,
        "conversations",
        conversationLocalId,
      )
    : null;
  const data = {
    ownerId,
    conversationId: conversationId ?? undefined,
    content: ensureString(row, "content"),
    embedding: asArray<number>(row.embedding),
    accessedAt: ensureNumber(row, "accessedAt"),
    createdAt: ensureNumber(row, "createdAt"),
    updatedAt: asNumber(row.updatedAt),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("memories", data);
  return String(createdId);
};

const upsertMemoryExtractionBatches = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"memory_extraction_batches">(
    ctx,
    ownerId,
    "memory_extraction_batches",
    localId,
  );
  const conversationLocalId = asString(row.conversationLocalId);
  const conversationId = conversationLocalId
    ? await getMappedId<"conversations">(
        ctx,
        ownerId,
        "conversations",
        conversationLocalId,
      )
    : null;
  const data = {
    ownerId,
    conversationId: conversationId ?? undefined,
    trigger: ensureString(row, "trigger"),
    windowStart: ensureNumber(row, "windowStart"),
    windowEnd: ensureNumber(row, "windowEnd"),
    snapshot: await parseMemorySnapshot(ctx, ownerId, row.snapshot),
    createdAt: ensureNumber(row, "createdAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("memory_extraction_batches", data);
  return String(createdId);
};

const upsertHeartbeatConfigs = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"heartbeat_configs">(
    ctx,
    ownerId,
    "heartbeat_configs",
    localId,
  );
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const activeHours = asRecord(row.activeHours);
  const data = {
    ownerId,
    conversationId,
    enabled: asBoolean(row.enabled) ?? true,
    intervalMs: ensureNumber(row, "intervalMs"),
    prompt: asString(row.prompt),
    checklist: asString(row.checklist),
    ackMaxChars: asNumber(row.ackMaxChars),
    deliver: asBoolean(row.deliver),
    agentType: asString(row.agentType),
    activeHours: activeHours
      ? {
          start: asString(activeHours.start) ?? "00:00",
          end: asString(activeHours.end) ?? "23:59",
          timezone: asString(activeHours.timezone),
        }
      : undefined,
    targetDeviceId: asString(row.targetDeviceId),
    lastRunAtMs: asNumber(row.lastRunAtMs),
    nextRunAtMs: ensureNumber(row, "nextRunAtMs"),
    lastStatus: asString(row.lastStatus),
    lastError: asString(row.lastError),
    lastSentText: asString(row.lastSentText),
    lastSentAtMs: asNumber(row.lastSentAtMs),
    createdAt: ensureNumber(row, "createdAt"),
    updatedAt: ensureNumber(row, "updatedAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("heartbeat_configs", data);
  return String(createdId);
};

const upsertCronJobs = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId =
    await getMappedId<"cron_jobs">(ctx, ownerId, "cron_jobs", localId);
  const conversationLocalId = asString(row.conversationLocalId);
  const conversationId = conversationLocalId
    ? await getMappedId<"conversations">(
        ctx,
        ownerId,
        "conversations",
        conversationLocalId,
      )
    : null;
  const schedule = parseCronSchedule(row.schedule);
  const payload = parseCronPayload(row.payload);
  const data = {
    ownerId,
    conversationId: conversationId ?? undefined,
    name: ensureString(row, "name"),
    description: asString(row.description),
    enabled: asBoolean(row.enabled) ?? true,
    schedule,
    sessionTarget: ensureString(row, "sessionTarget"),
    payload,
    deleteAfterRun: asBoolean(row.deleteAfterRun),
    nextRunAtMs: ensureNumber(row, "nextRunAtMs"),
    runningAtMs: asNumber(row.runningAtMs),
    lastRunAtMs: asNumber(row.lastRunAtMs),
    lastStatus: asString(row.lastStatus),
    lastError: asString(row.lastError),
    lastDurationMs: asNumber(row.lastDurationMs),
    lastOutputPreview: asString(row.lastOutputPreview),
    createdAt: ensureNumber(row, "createdAt"),
    updatedAt: ensureNumber(row, "updatedAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("cron_jobs", data);
  return String(createdId);
};

const upsertUsageLogs = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId =
    await getMappedId<"usage_logs">(ctx, ownerId, "usage_logs", localId);
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const data = {
    ownerId,
    conversationId,
    agentType: ensureString(row, "agentType"),
    model: ensureString(row, "model"),
    inputTokens: asNumber(row.inputTokens),
    outputTokens: asNumber(row.outputTokens),
    totalTokens: asNumber(row.totalTokens),
    durationMs: ensureNumber(row, "durationMs"),
    success: asBoolean(row.success) ?? true,
    fallbackUsed: asBoolean(row.fallbackUsed),
    toolCalls: asNumber(row.toolCalls),
    createdAt: ensureNumber(row, "createdAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("usage_logs", data);
  return String(createdId);
};

const upsertSelfModFeatures = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"self_mod_features">(
    ctx,
    ownerId,
    "self_mod_features",
    localId,
  );
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const data = {
    featureId: ensureString(row, "featureId"),
    ownerId,
    conversationId,
    name: ensureString(row, "name"),
    description: asString(row.description),
    status: ensureString(row, "status"),
    batchCount: ensureNumber(row, "batchCount"),
    files: asArray<string>(row.files) ?? [],
    createdAt: ensureNumber(row, "createdAt"),
    updatedAt: ensureNumber(row, "updatedAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const createdId = await ctx.db.insert("self_mod_features", data);
  return String(createdId);
};

const upsertStoreInstalls = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"store_installs">(
    ctx,
    ownerId,
    "store_installs",
    localId,
  );
  const packageId = ensureString(row, "packageId");
  const data = {
    ownerId,
    packageId,
    installedVersion: ensureString(row, "installedVersion"),
    installedAt: ensureNumber(row, "installedAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const existingByPackage = await ctx.db
    .query("store_installs")
    .withIndex("by_owner_package", (q) =>
      q.eq("ownerId", ownerId).eq("packageId", packageId),
    )
    .first();
  if (existingByPackage) {
    await ctx.db.patch(existingByPackage._id, data);
    return String(existingByPackage._id);
  }

  const createdId = await ctx.db.insert("store_installs", data);
  return String(createdId);
};

const upsertCanvasStates = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const existingId = await getMappedId<"canvas_states">(
    ctx,
    ownerId,
    "canvas_states",
    localId,
  );
  const conversationId = await resolveConversationId(ctx, ownerId, row);
  const data = {
    ownerId,
    conversationId,
    name: ensureString(row, "name"),
    title: asString(row.title),
    url: asString(row.url),
    width: asNumber(row.width),
    updatedAt: ensureNumber(row, "updatedAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const existingByConversation = await ctx.db
    .query("canvas_states")
    .withIndex("by_owner_conversation", (q) =>
      q.eq("ownerId", ownerId).eq("conversationId", conversationId),
    )
    .first();
  if (existingByConversation) {
    await ctx.db.patch(existingByConversation._id, data);
    return String(existingByConversation._id);
  }

  const createdId = await ctx.db.insert("canvas_states", data);
  return String(createdId);
};

const upsertUserPreferences = async (
  ctx: MutationCtx,
  ownerId: string,
  localId: string,
  row: Record<string, unknown>,
) => {
  const key = ensureString(row, "key");
  if (key.startsWith(`${LOCAL_SYNC_MAP_PREFIX}:`)) {
    throw new Error("Refusing to sync reserved mapping preference keys");
  }

  const existingId = await getMappedId<"user_preferences">(
    ctx,
    ownerId,
    "user_preferences",
    localId,
  );
  const data = {
    ownerId,
    key,
    value: ensureString(row, "value"),
    updatedAt: ensureNumber(row, "updatedAt"),
  };

  if (existingId) {
    await ctx.db.patch(existingId, data);
    return String(existingId);
  }

  const existingByKey = await ctx.db
    .query("user_preferences")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .first();
  if (existingByKey) {
    await ctx.db.patch(existingByKey._id, data);
    return String(existingByKey._id);
  }

  const createdId = await ctx.db.insert("user_preferences", data);
  return String(createdId);
};

const upsertByTable = async (
  ctx: MutationCtx,
  ownerId: string,
  table: SyncTableName,
  localId: string,
  row: Record<string, unknown>,
) => {
  switch (table) {
    case "conversations":
      return await upsertConversations(ctx, ownerId, localId, row);
    case "events":
      return await upsertEvents(ctx, ownerId, localId, row);
    case "attachments":
      return await upsertAttachments(ctx, ownerId, localId, row);
    case "tasks":
      return await upsertTasks(ctx, ownerId, localId, row);
    case "threads":
      return await upsertThreads(ctx, ownerId, localId, row);
    case "thread_messages":
      return await upsertThreadMessages(ctx, ownerId, localId, row);
    case "memories":
      return await upsertMemories(ctx, ownerId, localId, row);
    case "memory_extraction_batches":
      return await upsertMemoryExtractionBatches(ctx, ownerId, localId, row);
    case "heartbeat_configs":
      return await upsertHeartbeatConfigs(ctx, ownerId, localId, row);
    case "cron_jobs":
      return await upsertCronJobs(ctx, ownerId, localId, row);
    case "usage_logs":
      return await upsertUsageLogs(ctx, ownerId, localId, row);
    case "self_mod_features":
      return await upsertSelfModFeatures(ctx, ownerId, localId, row);
    case "store_installs":
      return await upsertStoreInstalls(ctx, ownerId, localId, row);
    case "canvas_states":
      return await upsertCanvasStates(ctx, ownerId, localId, row);
    case "user_preferences":
      return await upsertUserPreferences(ctx, ownerId, localId, row);
  }
};

const deleteByTable = async (
  ctx: MutationCtx,
  ownerId: string,
  table: SyncTableName,
  localId: string,
) => {
  const remoteId = await getMapping(ctx, ownerId, table, localId);
  if (!remoteId) {
    return;
  }

  switch (table) {
    case "conversations": {
      const typedId = remoteId as Id<"conversations">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "events": {
      const typedId = remoteId as Id<"events">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "attachments": {
      const typedId = remoteId as Id<"attachments">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "tasks": {
      const typedId = remoteId as Id<"tasks">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "threads": {
      const typedId = remoteId as Id<"threads">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "thread_messages": {
      const typedId = remoteId as Id<"thread_messages">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "memories": {
      const typedId = remoteId as Id<"memories">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "memory_extraction_batches": {
      const typedId = remoteId as Id<"memory_extraction_batches">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "heartbeat_configs": {
      const typedId = remoteId as Id<"heartbeat_configs">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "cron_jobs": {
      const typedId = remoteId as Id<"cron_jobs">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "usage_logs": {
      const typedId = remoteId as Id<"usage_logs">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "self_mod_features": {
      const typedId = remoteId as Id<"self_mod_features">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "store_installs": {
      const typedId = remoteId as Id<"store_installs">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "canvas_states": {
      const typedId = remoteId as Id<"canvas_states">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
    case "user_preferences": {
      const typedId = remoteId as Id<"user_preferences">;
      if (await ctx.db.get(typedId)) await ctx.db.delete(typedId);
      break;
    }
  }

  await clearMapping(ctx, ownerId, table, localId);
};

export const getSyncGateStatus = query({
  args: {},
  returns: syncGateStatusValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const runtimeMode = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) =>
        q.eq("ownerId", ownerId).eq("key", RUNTIME_MODE_KEY),
      )
      .first();
    const has247 = runtimeMode?.value === "cloud_247";

    const channelConnections = await ctx.db
      .query("channel_connections")
      .withIndex("by_owner_provider", (q) => q.eq("ownerId", ownerId))
      .collect();
    const connectedProviders = new Set(
      channelConnections.map((connection) => connection.provider),
    );

    const bridgeSessions = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_owner_provider", (q) => q.eq("ownerId", ownerId))
      .collect();
    for (const session of bridgeSessions) {
      if (ACTIVE_BRIDGE_STATUSES.has(session.status)) {
        connectedProviders.add(session.provider);
      }
    }

    const providers = [...connectedProviders].sort();
    const hasConnector = providers.length > 0;

    return {
      enabled: has247 || hasConnector,
      has247,
      hasConnector,
      connectedProviders: providers,
    };
  },
});

export const applyLocalSyncBatch = mutation({
  args: {
    upserts: v.array(syncUpsertItemValidator),
    deletes: v.array(syncDeleteItemValidator),
  },
  returns: v.object({
    upserts: v.array(syncSuccessItemValidator),
    deletes: v.array(syncSuccessItemValidator),
    errors: v.array(syncErrorItemValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const upserts: Array<{ table: SyncTableName; localId: string; remoteId?: string }> = [];
    const deletes: Array<{ table: SyncTableName; localId: string; remoteId?: string }> = [];
    const errors: Array<{ table: SyncTableName; localId: string; message: string }> = [];

    for (const item of args.upserts) {
      try {
        const row = asRecord(item.row);
        if (!row) {
          throw new Error("Invalid row payload");
        }
        const remoteId = await upsertByTable(
          ctx,
          ownerId,
          item.table,
          item.localId,
          row,
        );
        await setMapping(ctx, ownerId, item.table, item.localId, remoteId);
        upserts.push({
          table: item.table,
          localId: item.localId,
          remoteId,
        });
      } catch (error) {
        errors.push({
          table: item.table,
          localId: item.localId,
          message:
            error instanceof Error ? error.message : "Unknown sync upsert error",
        });
      }
    }

    for (const item of args.deletes) {
      try {
        await deleteByTable(ctx, ownerId, item.table, item.localId);
        deletes.push({
          table: item.table,
          localId: item.localId,
        });
      } catch (error) {
        errors.push({
          table: item.table,
          localId: item.localId,
          message:
            error instanceof Error ? error.message : "Unknown sync delete error",
        });
      }
    }

    return { upserts, deletes, errors };
  },
});
