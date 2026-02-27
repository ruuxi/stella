import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireUserId } from "../auth";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
} from "../automation/utils";
import {
  claimAndScheduleDueRuns,
  claimAndScheduleSingleRun,
  claimRunIfAvailable,
  DEFAULT_STUCK_RUN_MS,
  listDueByNextRunAtMs,
} from "./claim_flow";
import {
  buildExecutionCandidates,
  resolveOwnedConversationId,
  runAgentTurnWithFallback,
} from "./execution_policy";

const ACTIVE_HOURS_TIME_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
const DUPLICATE_SUPPRESSION_MS = 24 * 60 * 60 * 1000;
const STUCK_RUN_MS = DEFAULT_STUCK_RUN_MS;

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
  runningAtMs: v.optional(v.number()),
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

export const getConfig = internalQuery({
  args: {
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conversationId = await resolveOwnedConversationId(ctx, ownerId, args.conversationId);
    if (!conversationId) {
      return null;
    }
    return await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", conversationId),
      )
      .unique();
  },
});

export const upsertConfig = internalMutation({
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
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conversationId = await resolveOwnedConversationId(ctx, ownerId, args.conversationId);
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
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", conversationId),
      )
      .unique();

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
        runningAtMs: undefined,
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
      runningAtMs: undefined,
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
  handler: async (ctx, args) => {
    return await listDueByNextRunAtMs(ctx, {
      table: "heartbeat_configs",
      nowMs: args.nowMs,
      limit: args.limit,
    });
  },
});

export const getById = internalQuery({
  args: {
    id: v.id("heartbeat_configs"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const markRunning = internalMutation({
  args: {
    id: v.id("heartbeat_configs"),
    runningAtMs: v.number(),
    nextRunAtMs: v.number(),
    lastRunAtMs: v.number(),
    expectedRunningAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await claimRunIfAvailable({
      ctx,
      table: "heartbeat_configs",
      id: args.id,
      runningAtMs: args.runningAtMs,
      expectedRunningAtMs: args.expectedRunningAtMs,
      stuckRunMs: STUCK_RUN_MS,
      patch: {
        nextRunAtMs: args.nextRunAtMs,
        lastRunAtMs: args.lastRunAtMs,
      },
    });
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
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      lastStatus: args.status,
      lastError: args.error,
      lastSentText: args.lastSentText,
      lastSentAtMs: args.lastSentAtMs,
      runningAtMs: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    await claimAndScheduleDueRuns({
      nowMs: now,
      stuckRunMs: STUCK_RUN_MS,
      listDue: (listArgs) =>
        ctx.runQuery(internal.scheduling.heartbeat.listDue, {
          nowMs: listArgs.nowMs,
          limit: listArgs.limit,
        }),
      markRunning: (markArgs: {
        id: Id<"heartbeat_configs">;
        runningAtMs: number;
        nextRunAtMs: number;
        lastRunAtMs: number;
        expectedRunningAtMs?: number;
      }) =>
        ctx.runMutation(internal.scheduling.heartbeat.markRunning, markArgs),
      buildClaimArgs: (config, claimContext) => {
        const intervalMs = normalizeIntervalMs(config.intervalMs);
        return {
          id: config._id,
          runningAtMs: claimContext.nowMs,
          nextRunAtMs: claimContext.nowMs + intervalMs,
          lastRunAtMs: claimContext.nowMs,
          expectedRunningAtMs: claimContext.expectedRunningAtMs,
        };
      },
      schedule: (config) =>
        ctx.scheduler.runAfter(0, internal.scheduling.heartbeat.run, {
          configId: config._id,
          reason: "interval",
        }),
    });
    return null;
  },
});

export const run = internalAction({
  args: {
    configId: v.id("heartbeat_configs"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const config = await ctx.runQuery(internal.scheduling.heartbeat.getById, {
      id: args.configId,
    });
    if (!config) {
      return null;
    }
    if (!config.enabled) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "skipped:disabled",
      });
      return null;
    }

    const now = Date.now();
    const accountMode = await ctx.runQuery(
      internal.data.preferences.getAccountModeForOwner,
      { ownerId: config.ownerId },
    );
    if (accountMode !== "connected") {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "skipped:account-mode",
      });
      return null;
    }
    const syncMode = await ctx.runQuery(
      internal.data.preferences.getSyncModeForOwner,
      { ownerId: config.ownerId },
    );
    const transient = syncMode === "off";

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

    let targetDeviceId: string | undefined = config.targetDeviceId ?? undefined;
    let spriteName: string | undefined;
    if (!targetDeviceId) {
      const target = await ctx.runQuery(
        internal.agent.device_resolver.resolveExecutionTarget,
        { ownerId: config.ownerId },
      );
      targetDeviceId = target.targetDeviceId ?? undefined;
      spriteName = target.spriteName ?? undefined;
    }

    const agentType = config.agentType ?? "orchestrator";
    const candidates = buildExecutionCandidates({
      targetDeviceId,
      spriteName,
    });

    let text = "";
    let silent = false;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    try {
      const result = await runAgentTurnWithFallback({
        ctx,
        conversationId,
        prompt,
        agentType,
        ownerId: config.ownerId,
        transient,
        candidates,
      });
      text = result.text ?? "";
      silent = result.silent;
      usage = result.usage;
    } catch (error) {
      await ctx.runMutation(internal.scheduling.heartbeat.recordRun, {
        id: config._id,
        status: "failed",
        error:
          syncMode === "off"
            ? "run failed while sync is off"
            : ((error as Error).message ?? "Heartbeat failed"),
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

    const deliver = config.deliver !== false && syncMode !== "off";
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

export const runNow = internalMutation({
  args: {
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conversationId = await resolveOwnedConversationId(ctx, ownerId, args.conversationId);
    if (!conversationId) {
      return null;
    }
    const config = await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", conversationId),
      )
      .unique();
    if (!config) {
      return null;
    }
    const now = Date.now();
    const claimed = await claimAndScheduleSingleRun({
      nowMs: now,
      record: config,
      markRunning: (markArgs: {
        id: Id<"heartbeat_configs">;
        runningAtMs: number;
        nextRunAtMs: number;
        lastRunAtMs: number;
        expectedRunningAtMs?: number;
      }) =>
        ctx.runMutation(internal.scheduling.heartbeat.markRunning, markArgs),
      buildClaimArgs: (currentConfig, claimContext) => {
        const intervalMs = normalizeIntervalMs(currentConfig.intervalMs);
        return {
          id: currentConfig._id,
          runningAtMs: claimContext.nowMs,
          nextRunAtMs: claimContext.nowMs + intervalMs,
          lastRunAtMs: claimContext.nowMs,
          expectedRunningAtMs: claimContext.expectedRunningAtMs,
        };
      },
      schedule: (currentConfig) =>
        ctx.scheduler.runAfter(0, internal.scheduling.heartbeat.run, {
          configId: currentConfig._id,
          reason: "manual",
        }),
    });
    if (!claimed) {
      return await ctx.db.get(config._id);
    }
    return config;
  },
});
