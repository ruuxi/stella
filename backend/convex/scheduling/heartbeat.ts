import { internalAction, internalMutation, internalQuery, mutation, query, type QueryCtx, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireConversationOwner, requireUserId } from "../auth";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
} from "../automation/utils";
import { runAgentTurn } from "../automation/runner";

const ACTIVE_HOURS_TIME_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
const DUPLICATE_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

const activeHoursValidator = v.optional(
  v.object({
    start: v.string(),
    end: v.string(),
    timezone: v.optional(v.string()),
  }),
);

const heartbeatConfigValidator = v.object({
  _id: v.id("heartbeat_configs"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  enabled: v.boolean(),
  intervalMs: v.number(),
  prompt: v.optional(v.string()),
  checklist: v.optional(v.string()),
  ackMaxChars: v.optional(v.number()),
  deliver: v.optional(v.boolean()),
  agentType: v.optional(v.string()),
  activeHours: activeHoursValidator,
  targetDeviceId: v.optional(v.string()),
  lastRunAtMs: v.optional(v.number()),
  nextRunAtMs: v.number(),
  lastStatus: v.optional(v.string()),
  lastError: v.optional(v.string()),
  lastSentText: v.optional(v.string()),
  lastSentAtMs: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function normalizeIntervalMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  const clamped = Math.max(60_000, Math.floor(value));
  return clamped;
}

function resolveActiveHoursTimezone(raw?: string) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "local" || trimmed === "user") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
}

function parseActiveHoursTime(opts: { allow24: boolean }, raw?: string): number | null {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    if (!opts.allow24 || minute !== 0) {
      return null;
    }
    return 24 * 60;
  }
  return hour * 60 + minute;
}

function resolveMinutesInTimeZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isWithinActiveHours(
  active: { start: string; end: string; timezone?: string } | null | undefined,
  nowMs: number,
) {
  if (!active) {
    return true;
  }
  const startMin = parseActiveHoursTime({ allow24: false }, active.start);
  const endMin = parseActiveHoursTime({ allow24: true }, active.end);
  if (startMin === null || endMin === null) {
    return true;
  }
  if (startMin === endMin) {
    return true;
  }

  const timeZone = resolveActiveHoursTimezone(active.timezone);
  const currentMin = resolveMinutesInTimeZone(nowMs, timeZone);
  if (currentMin === null) {
    return true;
  }
  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  return currentMin >= startMin || currentMin < endMin;
}

async function resolveConversationId(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  conversationId?: Id<"conversations">,
): Promise<Id<"conversations"> | null> {
  if (conversationId) {
    const conversation = await requireConversationOwner(ctx, conversationId);
    return conversation?._id ?? null;
  }
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_owner_default", (q) => q.eq("ownerId", ownerId).eq("isDefault", true))
    .first();
  return conversation?._id ?? null;
}

export const getConfig = query({
  args: {
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.union(heartbeatConfigValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conversationId = await resolveConversationId(ctx, ownerId, args.conversationId);
    if (!conversationId) {
      return null;
    }
    return await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_owner_conversation", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", conversationId),
      )
      .first();
  },
});

export const upsertConfig = mutation({
  args: {
    conversationId: v.optional(v.id("conversations")),
    enabled: v.optional(v.boolean()),
    intervalMs: v.optional(v.number()),
    prompt: v.optional(v.string()),
    checklist: v.optional(v.string()),
    ackMaxChars: v.optional(v.number()),
    deliver: v.optional(v.boolean()),
    agentType: v.optional(v.string()),
    activeHours: activeHoursValidator,
    targetDeviceId: v.optional(v.string()),
  },
  returns: v.union(heartbeatConfigValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conversationId = await resolveConversationId(ctx, ownerId, args.conversationId);
    if (!conversationId) {
      return null;
    }

    const now = Date.now();
    const intervalMs = normalizeIntervalMs(args.intervalMs);
    const enabled = args.enabled ?? true;
    const ackMaxChars =
      typeof args.ackMaxChars === "number" && Number.isFinite(args.ackMaxChars)
        ? Math.max(0, Math.floor(args.ackMaxChars))
        : undefined;

    const existing = await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_owner_conversation", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", conversationId),
      )
      .first();

    const nextRunAtMs = now + intervalMs;

    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled,
        intervalMs,
        prompt: args.prompt ?? existing.prompt,
        checklist: args.checklist ?? existing.checklist,
        ackMaxChars,
        deliver: args.deliver ?? existing.deliver,
        agentType: args.agentType ?? existing.agentType,
        activeHours: args.activeHours ?? existing.activeHours,
        targetDeviceId: args.targetDeviceId ?? existing.targetDeviceId,
        nextRunAtMs,
        updatedAt: now,
      });
      return await ctx.db.get(existing._id);
    }

    const id = await ctx.db.insert("heartbeat_configs", {
      ownerId,
      conversationId,
      enabled,
      intervalMs,
      prompt: args.prompt,
      checklist: args.checklist,
      ackMaxChars,
      deliver: args.deliver,
      agentType: args.agentType,
      activeHours: args.activeHours,
      targetDeviceId: args.targetDeviceId,
      lastRunAtMs: undefined,
      nextRunAtMs,
      lastStatus: undefined,
      lastError: undefined,
      lastSentText: undefined,
      lastSentAtMs: undefined,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(id);
  },
});

export const listDue = internalQuery({
  args: {
    nowMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(heartbeatConfigValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200);
    const due = await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_next_run", (q) => q.lte("nextRunAtMs", args.nowMs))
      .take(limit);
    return due;
  },
});

export const getById = internalQuery({
  args: {
    id: v.id("heartbeat_configs"),
  },
  returns: v.union(heartbeatConfigValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const markScheduled = internalMutation({
  args: {
    id: v.id("heartbeat_configs"),
    nextRunAtMs: v.number(),
    lastRunAtMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      nextRunAtMs: args.nextRunAtMs,
      lastRunAtMs: args.lastRunAtMs,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const recordRun = internalMutation({
  args: {
    id: v.id("heartbeat_configs"),
    status: v.string(),
    error: v.optional(v.string()),
    lastSentText: v.optional(v.string()),
    lastSentAtMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      lastStatus: args.status,
      lastError: args.error,
      lastSentText: args.lastSentText,
      lastSentAtMs: args.lastSentAtMs,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const tick = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.runQuery(internal.scheduling.heartbeat.listDue, { nowMs: now, limit: 100 });
    for (const config of due) {
      if (!config.enabled) {
        continue;
      }
      const intervalMs = normalizeIntervalMs(config.intervalMs);
      const nextRunAtMs = now + intervalMs;
      await ctx.runMutation(internal.scheduling.heartbeat.markScheduled, {
        id: config._id,
        nextRunAtMs,
        lastRunAtMs: now,
      });
      await ctx.scheduler.runAfter(0, internal.scheduling.heartbeat.run, {
        configId: config._id,
        reason: "interval",
      });
    }
    return null;
  },
});

export const run = internalAction({
  args: {
    configId: v.id("heartbeat_configs"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.runQuery(internal.scheduling.heartbeat.getById, {
      id: args.configId,
    });
    if (!config || !config.enabled) {
      return null;
    }

    const now = Date.now();
    if (!isWithinActiveHours(config.activeHours, now)) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "skipped:quiet-hours",
      });
      return null;
    }

    const prompt = resolveHeartbeatPrompt({
      prompt: config.prompt,
      checklist: config.checklist,
    });
    if (config.checklist && isHeartbeatContentEffectivelyEmpty(config.checklist)) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "skipped:empty-checklist",
      });
      return null;
    }

    const conversationId = config.conversationId;
    const targetDeviceId =
      config.targetDeviceId ??
      (await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
        conversationId,
      })) ??
      undefined;

    // Cloud device fallback: if no local device, check for a Sprites cloud device
    const spriteName = !targetDeviceId
      ? await ctx.runQuery(internal.agent.cloud_devices.resolveForOwner, { ownerId: config.ownerId })
      : undefined;

    const agentType = config.agentType ?? "orchestrator";

    let text = "";
    let silent = false;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    try {
      const result = await runAgentTurn({
        ctx,
        conversationId,
        prompt,
        agentType,
        ownerId: config.ownerId,
        targetDeviceId: targetDeviceId ?? undefined,
        spriteName: spriteName ?? undefined,
        includeHistory: true,
      });
      text = result.text ?? "";
      silent = result.silent;
      usage = result.usage;
    } catch (error) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "failed",
        error: (error as Error).message ?? "Heartbeat failed",
      });
      return null;
    }

    if (silent) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "no-response",
      });
      return null;
    }

    const finalText = text.trim();
    if (!finalText) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "ok-empty",
      });
      return null;
    }

    const dedupeText = config.lastSentText?.trim() ?? "";
    const lastSentAtMs = typeof config.lastSentAtMs === "number" ? config.lastSentAtMs : 0;
    const isDuplicate =
      dedupeText &&
      finalText === dedupeText &&
      lastSentAtMs > 0 &&
      now - lastSentAtMs < DUPLICATE_SUPPRESSION_MS;
    if (isDuplicate) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "skipped:duplicate",
      });
      return null;
    }

    const deliver = config.deliver !== false;
    if (deliver) {
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId,
        type: "assistant_message",
        payload: {
          text: finalText,
          source: "heartbeat",
          heartbeatConfigId: config._id,
          reason: args.reason ?? "scheduled",
          usage,
        },
      });
    }

    await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
      id: config._id,
      status: deliver ? "sent" : "completed",
      lastSentText: deliver ? finalText : undefined,
      lastSentAtMs: deliver ? now : undefined,
    });
    return null;
  },
});

export const runNow = mutation({
  args: {
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.union(heartbeatConfigValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conversationId = await resolveConversationId(ctx, ownerId, args.conversationId);
    if (!conversationId) {
      return null;
    }
    const config = await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_owner_conversation", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", conversationId),
      )
      .first();
    if (!config) {
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.scheduling.heartbeat.run, {
      configId: config._id,
      reason: "manual",
    });
    return config;
  },
});
