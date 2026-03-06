import { Cron } from "croner";
import { mutation, internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireConversationOwner, requireUserId } from "../auth";
import {
  claimAndScheduleSingleRun,
  claimRunIfAvailable,
  DEFAULT_STUCK_RUN_MS,
} from "./claim_flow";
import {
  buildDesktopTurnCandidates,
  resolveOwnedConversationId,
  runAgentTurnWithCloudFallback,
} from "./desktop_handoff_policy";
import {
  cronScheduleValidator,
  cronPayloadValidator,
} from "../schema/scheduling";

const STUCK_RUN_MS = DEFAULT_STUCK_RUN_MS;
const MAX_PREVIEW_CHARS = 800;
const DISABLED_CRON_FAR_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronPayload =
  | { kind: "systemEvent"; text: string; agentType?: string; deliver?: boolean }
  | {
      kind: "agentTurn";
      message: string;
      agentType?: string;
      deliver?: boolean;
    };

const cronPatchValidator = v.object({
  name: v.optional(v.string()),
  schedule: v.optional(cronScheduleValidator),
  payload: v.optional(cronPayloadValidator),
  sessionTarget: v.optional(v.string()),
  conversationId: v.optional(v.id("conversations")),
  description: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
  deleteAfterRun: v.optional(v.boolean()),
});

function truncatePreview(value: string) {
  if (value.length <= MAX_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_PREVIEW_CHARS)}...`;
}

function assertValidSchedule(schedule: unknown): CronSchedule {
  if (!schedule || typeof schedule !== "object") {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "schedule must be an object" });
  }
  const record = schedule as Record<string, unknown>;
  const kind = String(record.kind ?? "").trim();
  if (kind === "at") {
    const atMs = Number(record.atMs);
    if (!Number.isFinite(atMs) || atMs <= 0) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'schedule.kind="at" requires atMs (epoch ms)' });
    }
    return { kind: "at" as const, atMs };
  }
  if (kind === "every") {
    const everyMs = Number(record.everyMs);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'schedule.kind="every" requires everyMs (>0)' });
    }
    const anchorRaw = record.anchorMs;
    const anchorMs =
      typeof anchorRaw === "number" && Number.isFinite(anchorRaw) ? anchorRaw : undefined;
    return { kind: "every" as const, everyMs, anchorMs };
  }
  if (kind === "cron") {
    const expr = typeof record.expr === "string" ? record.expr.trim() : "";
    if (!expr) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'schedule.kind="cron" requires expr' });
    }
    const tz = typeof record.tz === "string" ? record.tz.trim() : undefined;
    return { kind: "cron" as const, expr, tz };
  }
  throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'schedule.kind must be "at", "every", or "cron"' });
}

function assertValidPayload(payload: unknown): CronPayload {
  if (!payload || typeof payload !== "object") {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "payload must be an object" });
  }
  const record = payload as Record<string, unknown>;
  const kind = String(record.kind ?? "").trim();
  if (kind === "systemEvent") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'payload.kind="systemEvent" requires text' });
    }
    const agentType = typeof record.agentType === "string" ? record.agentType.trim() : undefined;
    const deliver = typeof record.deliver === "boolean" ? record.deliver : undefined;
    return { kind: "systemEvent" as const, text, agentType, deliver };
  }
  if (kind === "agentTurn") {
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (!message) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'payload.kind="agentTurn" requires message' });
    }
    const agentType = typeof record.agentType === "string" ? record.agentType.trim() : undefined;
    const deliver = typeof record.deliver === "boolean" ? record.deliver : undefined;
    return { kind: "agentTurn" as const, message, agentType, deliver };
  }
  throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'payload.kind must be "systemEvent" or "agentTurn"' });
}


const sanitizeCronJobForReturn = <T extends { payload: unknown } | null>(
  job: T,
): T => {
  if (!job) {
    return job;
  }
  return {
    ...job,
    payload: assertValidPayload(job.payload),
  };
};

function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    return schedule.atMs > nowMs ? schedule.atMs : nowMs;
  }
  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }
  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  const cron = new Cron(expr, {
    timezone: schedule.tz?.trim() || undefined,
    catch: false,
  });
  const next = cron.nextRun(new Date(nowMs));
  return next ? next.getTime() : undefined;
}

async function cancelScheduledRun(
  ctx: { scheduler: { cancel: (id: Id<"_scheduled_functions">) => Promise<void> } },
  scheduledRunId: Id<"_scheduled_functions"> | undefined,
) {
  if (!scheduledRunId) return;
  try {
    await ctx.scheduler.cancel(scheduledRunId);
  } catch {
    // Already completed or cancelled
  }
}

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const jobs = await ctx.db
      .query("cron_jobs")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
    return jobs.map((job) => sanitizeCronJobForReturn(job));
  },
});

export const add = internalMutation({
  args: {
    name: v.string(),
    schedule: cronScheduleValidator,
    payload: cronPayloadValidator,
    sessionTarget: v.string(),
    conversationId: v.optional(v.id("conversations")),
    description: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    deleteAfterRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const schedule = assertValidSchedule(args.schedule);
    const payload = assertValidPayload(args.payload);
    const sessionTarget = args.sessionTarget.trim();
    if (sessionTarget !== "main" && sessionTarget !== "isolated") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'sessionTarget must be "main" or "isolated"' });
    }
    if (sessionTarget === "main" && payload.kind !== "systemEvent") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'sessionTarget="main" requires payload.kind="systemEvent"' });
    }
    if (sessionTarget === "isolated" && payload.kind !== "agentTurn") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'sessionTarget="isolated" requires payload.kind="agentTurn"' });
    }

    const conversationId = await resolveOwnedConversationId(ctx, ownerId, args.conversationId);
    if (!conversationId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No conversation available for cron job." });
    }

    const now = Date.now();
    const nextRunAtMs = computeNextRunAtMs(schedule, now);
    if (!nextRunAtMs) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Unable to compute next run for schedule." });
    }
    const enabled = args.enabled ?? true;

    const id = await ctx.db.insert("cron_jobs", {
      ownerId,
      conversationId,
      name: args.name.trim() || "Scheduled job",
      description: args.description?.trim(),
      enabled,
      schedule,
      sessionTarget,
      payload,
      deleteAfterRun: args.deleteAfterRun,
      nextRunAtMs,
      scheduledRunId: undefined,
      runningAtMs: undefined,
      lastRunAtMs: undefined,
      lastStatus: undefined,
      lastError: undefined,
      lastDurationMs: undefined,
      lastOutputPreview: undefined,
      createdAt: now,
      updatedAt: now,
    });

    // Schedule first run if enabled
    if (enabled) {
      const delayMs = Math.max(0, nextRunAtMs - now);
      const scheduledRunId = await ctx.scheduler.runAfter(
        delayMs,
        internal.scheduling.cron_jobs.execute,
        { jobId: id },
      );
      await ctx.db.patch(id, { scheduledRunId });
    }

    return sanitizeCronJobForReturn(await ctx.db.get(id));
  },
});

export const update = internalMutation({
  args: {
    jobId: v.id("cron_jobs"),
    patch: cronPatchValidator,
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    // Intentional silent null return: cron job ownership mismatch should not
    // throw because internal callers may race with job deletion/reassignment.
    if (!job || job.ownerId !== ownerId) {
      return null;
    }
    const patch = args.patch && typeof args.patch === "object" ? (args.patch as Record<string, unknown>) : {};

    let schedule = job.schedule as CronSchedule;
    if (patch.schedule !== undefined) {
      schedule = assertValidSchedule(patch.schedule);
    }
    let payload = job.payload as CronPayload;
    if (patch.payload !== undefined) {
      payload = assertValidPayload(patch.payload);
    }

    const sessionTargetRaw = patch.sessionTarget ?? job.sessionTarget;
    const sessionTarget = typeof sessionTargetRaw === "string" ? sessionTargetRaw.trim() : "";
    if (sessionTarget !== "main" && sessionTarget !== "isolated") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'sessionTarget must be "main" or "isolated"' });
    }
    if (sessionTarget === "main" && payload.kind !== "systemEvent") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'sessionTarget="main" requires payload.kind="systemEvent"' });
    }
    if (sessionTarget === "isolated" && payload.kind !== "agentTurn") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: 'sessionTarget="isolated" requires payload.kind="agentTurn"' });
    }

    const conversationId =
      patch.conversationId !== undefined
        ? await resolveOwnedConversationId(ctx, ownerId, patch.conversationId as Id<"conversations">)
        : job.conversationId;
    if (!conversationId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No conversation available for cron job." });
    }

    const enabled =
      typeof patch.enabled === "boolean" ? patch.enabled : (job.enabled ?? true);

    const now = Date.now();
    const nextRunAtMs = computeNextRunAtMs(schedule, now);
    if (!nextRunAtMs) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Unable to compute next run for schedule." });
    }

    // Cancel old scheduled run
    await cancelScheduledRun(ctx, job.scheduledRunId);

    await ctx.db.patch(job._id, {
      name: typeof patch.name === "string" ? patch.name.trim() || job.name : job.name,
      description:
        typeof patch.description === "string" ? patch.description.trim() : job.description,
      enabled,
      schedule,
      payload,
      sessionTarget,
      conversationId,
      deleteAfterRun:
        typeof patch.deleteAfterRun === "boolean" ? patch.deleteAfterRun : job.deleteAfterRun,
      nextRunAtMs,
      scheduledRunId: undefined,
      updatedAt: now,
    });

    // Schedule new run if enabled
    if (enabled) {
      const delayMs = Math.max(0, nextRunAtMs - now);
      const scheduledRunId = await ctx.scheduler.runAfter(
        delayMs,
        internal.scheduling.cron_jobs.execute,
        { jobId: job._id },
      );
      await ctx.db.patch(job._id, { scheduledRunId });
    }

    return sanitizeCronJobForReturn(await ctx.db.get(job._id));
  },
});

export const remove = internalMutation({
  args: {
    jobId: v.id("cron_jobs"),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    // Intentional silent null return: cron job ownership mismatch should not
    // throw because internal callers may race with job deletion/reassignment.
    if (!job || job.ownerId !== ownerId) {
      return null;
    }
    await cancelScheduledRun(ctx, job.scheduledRunId);
    await ctx.db.delete(job._id);
    return null;
  },
});

/**
 * Delete a cron job by ID. Skips ownership check because it is only called
 * from `execute` after the job has already been ownership-verified.
 */
export const deleteJob = internalMutation({
  args: {
    jobId: v.id("cron_jobs"),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job) {
      await cancelScheduledRun(ctx, job.scheduledRunId);
    }
    await ctx.db.delete(args.jobId);
    return null;
  },
});

export const run = internalMutation({
  args: {
    jobId: v.id("cron_jobs"),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    // Intentional silent null return: cron job ownership mismatch should not
    // throw because internal callers may race with job deletion/reassignment.
    if (!job || job.ownerId !== ownerId) {
      return null;
    }

    // Cancel existing scheduled run before manual trigger
    await cancelScheduledRun(ctx, job.scheduledRunId);
    await ctx.db.patch(job._id, { scheduledRunId: undefined });

    const now = Date.now();
    const claimed = await claimAndScheduleSingleRun({
      nowMs: now,
      record: job,
      markRunning: (markArgs: {
        id: Id<"cron_jobs">;
        runningAtMs: number;
        expectedRunningAtMs?: number;
      }) =>
        ctx.runMutation(internal.scheduling.cron_jobs.markRunning, markArgs),
      buildClaimArgs: (currentJob, claimContext) => ({
        id: currentJob._id,
        runningAtMs: claimContext.nowMs,
        expectedRunningAtMs: claimContext.expectedRunningAtMs,
      }),
      schedule: (currentJob) =>
        ctx.scheduler.runAfter(0, internal.scheduling.cron_jobs.execute, {
          jobId: currentJob._id,
          forced: true,
        }),
    });
    if (!claimed) {
      return sanitizeCronJobForReturn(await ctx.db.get(job._id));
    }
    return sanitizeCronJobForReturn(await ctx.db.get(job._id));
  },
});

export const getById = internalQuery({
  args: {
    id: v.id("cron_jobs"),
  },
  handler: async (ctx, args) => {
    return sanitizeCronJobForReturn(await ctx.db.get(args.id));
  },
});

export const markRunning = internalMutation({
  args: {
    id: v.id("cron_jobs"),
    runningAtMs: v.number(),
    expectedRunningAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await claimRunIfAvailable({
      ctx,
      table: "cron_jobs",
      id: args.id,
      runningAtMs: args.runningAtMs,
      expectedRunningAtMs: args.expectedRunningAtMs,
      stuckRunMs: STUCK_RUN_MS,
      patch: {
        lastError: undefined,
      },
    });
  },
});

export const finishRun = internalMutation({
  args: {
    id: v.id("cron_jobs"),
    nextRunAtMs: v.optional(v.number()),
    runningAtMs: v.optional(v.number()),
    lastRunAtMs: v.optional(v.number()),
    lastStatus: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastDurationMs: v.optional(v.number()),
    lastOutputPreview: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job) {
      return null;
    }

    // Cancel any existing scheduled run
    await cancelScheduledRun(ctx, job.scheduledRunId);

    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
      scheduledRunId: undefined,
    };
    if (args.nextRunAtMs !== undefined) patch.nextRunAtMs = args.nextRunAtMs;
    if (args.runningAtMs !== undefined) patch.runningAtMs = args.runningAtMs;
    if (args.lastRunAtMs !== undefined) patch.lastRunAtMs = args.lastRunAtMs;
    if (args.lastStatus !== undefined) patch.lastStatus = args.lastStatus;
    if (args.lastError !== undefined) patch.lastError = args.lastError;
    if (args.lastDurationMs !== undefined) patch.lastDurationMs = args.lastDurationMs;
    if (args.lastOutputPreview !== undefined) patch.lastOutputPreview = args.lastOutputPreview;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    await ctx.db.patch(args.id, patch);

    // Schedule next run if job still exists, is enabled, and has a next run time
    const resolvedEnabled = args.enabled !== undefined ? args.enabled : job.enabled;
    const resolvedNextRunAtMs = args.nextRunAtMs !== undefined ? args.nextRunAtMs : job.nextRunAtMs;
    if (resolvedEnabled && resolvedNextRunAtMs) {
      const delayMs = Math.max(0, resolvedNextRunAtMs - Date.now());
      const scheduledRunId = await ctx.scheduler.runAfter(
        delayMs,
        internal.scheduling.cron_jobs.execute,
        { jobId: args.id },
      );
      await ctx.db.patch(args.id, { scheduledRunId });
    }

    return null;
  },
});

export const execute = internalAction({
  args: {
    jobId: v.id("cron_jobs"),
    forced: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.scheduling.cron_jobs.getById, { id: args.jobId });
    if (!job || (!job.enabled && !args.forced)) {
      return null;
    }

    // Claim the run
    const now = Date.now();
    const claimed = await ctx.runMutation(internal.scheduling.cron_jobs.markRunning, {
      id: job._id,
      runningAtMs: now,
      expectedRunningAtMs: job.runningAtMs,
    });
    if (!claimed && !args.forced) {
      return null;
    }

    if (!args.forced && job.nextRunAtMs > now) {
      await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
        id: job._id,
        runningAtMs: undefined,
        lastStatus: "skipped:not-due",
      });
      return null;
    }

    let status: "ok" | "error" | "skipped" = "ok";
    let error: string | undefined;
    let outputText = "";
    const accountMode = await ctx.runQuery(
      internal.data.preferences.getAccountModeForOwner,
      { ownerId: job.ownerId },
    );
    const syncMode = await ctx.runQuery(
      internal.data.preferences.getSyncModeForOwner,
      { ownerId: job.ownerId },
    );
    const transient = syncMode === "off";
    const toPersistedError = (rawError?: string) =>
      transient && rawError ? "run failed while sync is off" : rawError;

    let schedule: CronSchedule | null = null;
    let payload: CronPayload | null = null;
    try {
      schedule = assertValidSchedule(job.schedule);
      payload = assertValidPayload(job.payload);
    } catch (err) {
      await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
        id: job._id,
        runningAtMs: undefined,
        lastStatus: "error",
        lastError: toPersistedError((err as Error).message ?? "invalid cron job"),
      });
      return null;
    }
    const conversationId = job.conversationId as Id<"conversations"> | undefined;
    if (!conversationId) {
      await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
        id: job._id,
        runningAtMs: undefined,
        lastStatus: "error",
        lastError: toPersistedError("cron job missing conversationId"),
      });
      return null;
    }

    const scheduleResolved = schedule as CronSchedule;
    const payloadResolved = payload as CronPayload;

    const promptBase =
      payloadResolved.kind === "systemEvent" ? payloadResolved.text : payloadResolved.message;
    const prompt =
      job.sessionTarget === "isolated"
        ? `[cron:${job._id} ${job.name}] ${promptBase}`.trim()
        : promptBase;

    if (accountMode !== "connected") {
      status = "skipped";
      error = "connected mode required";
    } else {
      try {
        const target = await ctx.runQuery(
          internal.agent.device_resolver.resolveExecutionTarget,
          { ownerId: job.ownerId },
        );
        const candidates = buildDesktopTurnCandidates({
          targetDeviceId: target.targetDeviceId,
        });
        const agentType = payloadResolved.agentType ?? "orchestrator";

        // Inverted execution: when the desktop is online, insert a
        // remote_turn_request and let the desktop run the AI turn locally.
        const firstCandidate = candidates[0];
        if (firstCandidate?.mode === "desktop" && !transient) {
          // Persist a synthetic user message so the desktop has a userMessageId
          const userMessageId = await ctx.runMutation(internal.events.appendInternalEvent, {
            conversationId,
            type: "user_message",
            payload: {
              text: prompt,
              source: "cron",
              cronJobId: String(job._id),
            },
          });

          const requestId = crypto.randomUUID();
          await ctx.runMutation(internal.events.appendInternalEvent, {
            conversationId,
            type: "remote_turn_request",
            targetDeviceId: firstCandidate.targetDeviceId,
            requestId,
            payload: {
              conversationId: String(conversationId),
              userMessageId: String(userMessageId),
              text: prompt,
              source: "cron",
              cronJobId: String(job._id),
              cronJobName: job.name,
              deliver: payloadResolved.deliver !== false,
              sessionTarget: job.sessionTarget,
            },
          });

          // Schedule next run — the desktop will update status on completion.
          // The orphan watchdog handles cases where the desktop goes offline.
          if (scheduleResolved.kind === "at") {
            // One-shot schedule: disable (don't retrigger). Desktop's
            // completeCronTurnResult will delete the job if deleteAfterRun.
            // Keep runningAtMs set (omit from args) so the claim guard blocks
            // overlapping runs; the stuck-run timeout handles desktop crashes.
            const farFuture = now + DISABLED_CRON_FAR_FUTURE_MS;
            await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
              id: job._id,
              nextRunAtMs: farFuture,
              lastRunAtMs: now,
              lastStatus: "deferred",
              enabled: false,
            });
          } else {
            // Repeating schedule: schedule the next run but keep the current
            // run's runningAtMs set to prevent overlap.
            const nextRunAtMs = computeNextRunAtMs(scheduleResolved, Date.now());
            await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
              id: job._id,
              nextRunAtMs: nextRunAtMs ?? now + 60_000,
              lastRunAtMs: now,
              lastStatus: "deferred",
            });
          }
          return null;
        }

        const { result } = await runAgentTurnWithCloudFallback({
          ctx,
          conversationId,
          prompt,
          agentType,
          ownerId: job.ownerId,
          transient,
          candidates,
        });
        outputText = (result.text ?? "").trim();
      } catch (err) {
        status = "error";
        error = (err as Error).message ?? "cron job failed";
      }
    }

    const durationMs = Date.now() - now;
    const nextRunAtMs = computeNextRunAtMs(scheduleResolved, Date.now());
    const shouldDelete =
      scheduleResolved.kind === "at" && status === "ok" && job.deleteAfterRun === true;
    const shouldDisable =
      scheduleResolved.kind === "at" && status === "ok" && job.deleteAfterRun !== true;
    const safeNextRunAtMs = nextRunAtMs ?? now + 60_000;
    const disabledNextRunAtMs = now + DISABLED_CRON_FAR_FUTURE_MS;
    const persistedOutputPreview =
      syncMode === "off"
        ? undefined
        : outputText
          ? truncatePreview(outputText)
          : undefined;
    const persistedError = toPersistedError(error);

    if (!shouldDelete) {
      await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
        id: job._id,
        nextRunAtMs: shouldDisable ? disabledNextRunAtMs : safeNextRunAtMs,
        runningAtMs: undefined,
        lastRunAtMs: now,
        lastStatus: status,
        lastError: persistedError,
        lastDurationMs: durationMs,
        lastOutputPreview: persistedOutputPreview,
        enabled: shouldDisable ? false : job.enabled,
      });
    } else {
      await ctx.runMutation(internal.scheduling.cron_jobs.finishRun, {
        id: job._id,
        nextRunAtMs: safeNextRunAtMs,
        runningAtMs: undefined,
        lastRunAtMs: now,
        lastStatus: status,
        lastError: persistedError,
        lastDurationMs: durationMs,
        lastOutputPreview: persistedOutputPreview,
      });
      await ctx.runMutation(internal.scheduling.cron_jobs.deleteJob, { jobId: job._id });
    }

    const deliver = payloadResolved.deliver !== false;
    if (deliver && outputText && syncMode !== "off") {
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId,
        type: "assistant_message",
        payload: {
          text: outputText,
          source: "cron",
          cronJobId: job._id,
          cronJobName: job.name,
          sessionTarget: job.sessionTarget,
        },
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// completeCronTurnResult — called by the desktop after inverted execution
// ---------------------------------------------------------------------------

type CompleteCronTurnStatus = "ok" | "error";

async function completeCronTurnResultCore(
  ctx: Pick<MutationCtx, "db">,
  args: {
    requestId: string;
    text: string;
    conversationId: Id<"conversations">;
    status?: CompleteCronTurnStatus;
    error?: string;
    skipAssistantMessage?: boolean;
    rescuedByWatchdog?: boolean;
  },
) {
  const status: CompleteCronTurnStatus = args.status ?? "ok";
  const trimmedText = args.text.trim();

  const request = await ctx.db
    .query("events")
    .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
    .first();
  if (!request || request.type !== "remote_turn_request") {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Invalid or missing remote_turn_request" });
  }
  if (request.conversationId !== args.conversationId) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Conversation mismatch" });
  }

  const reqPayload = request.payload as Record<string, unknown>;
  if (reqPayload.source !== "cron") {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Request is not a cron remote turn" });
  }

  const fulfilled = await ctx.db
    .query("events")
    .withIndex("by_requestId", (q) =>
      q.eq("requestId", `fulfilled:${args.requestId}`),
    )
    .first();
  if (fulfilled) return;

  const claimed = await ctx.db
    .query("events")
    .withIndex("by_requestId", (q) =>
      q.eq("requestId", `claimed:${args.requestId}`),
    )
    .first();
  if (!claimed) {
    await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp: Date.now(),
      type: "remote_turn_claimed",
      requestId: `claimed:${args.requestId}`,
      payload: {
        requestId: args.requestId,
        source: "cron",
        rescuedByWatchdog: args.rescuedByWatchdog === true,
      },
    });
  }

  const cronJobId = reqPayload.cronJobId as string | undefined;
  const cronJobName = reqPayload.cronJobName as string | undefined;
  const deliver = reqPayload.deliver as boolean | undefined;
  const sessionTarget = reqPayload.sessionTarget as string | undefined;

  if (cronJobId) {
    const jobId = cronJobId as Id<"cron_jobs">;
    const job = await ctx.db.get(jobId);
    if (job) {
      await ctx.db.patch(jobId, {
        runningAtMs: undefined,
        lastStatus: status,
        lastError:
          status === "error"
            ? args.error ?? "Cron remote turn failed before fulfillment."
            : undefined,
        lastOutputPreview:
          status === "ok" && trimmedText.length > 0
            ? truncatePreview(trimmedText)
            : undefined,
        updatedAt: Date.now(),
      });

      if (status === "ok" && job.deleteAfterRun === true) {
        await ctx.db.delete(jobId);
      }
    }
  }

  if (
    status === "ok" &&
    !args.skipAssistantMessage &&
    (deliver ?? true) &&
    trimmedText.length > 0
  ) {
    await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp: Date.now(),
      type: "assistant_message",
      payload: {
        text: trimmedText,
        source: "cron",
        cronJobId,
        cronJobName,
        sessionTarget,
      },
    });
  }

  await ctx.db.insert("events", {
    conversationId: args.conversationId,
    timestamp: Date.now(),
    type: "remote_turn_fulfilled",
    requestId: `fulfilled:${args.requestId}`,
    payload: {
      requestId: args.requestId,
      source: "cron",
      status,
      rescuedByWatchdog: args.rescuedByWatchdog === true,
      ...(status === "error" && args.error
        ? { error: args.error }
        : {}),
    },
  });
}

export const completeCronTurnResult = mutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    await completeCronTurnResultCore(ctx, {
      requestId: args.requestId,
      text: args.text,
      conversationId: args.conversationId,
      status: "ok",
    });

    return null;
  },
});

export const completeCronTurnResultFromWatchdog = internalMutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
    status: v.union(v.literal("ok"), v.literal("error")),
    error: v.optional(v.string()),
    skipAssistantMessage: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await completeCronTurnResultCore(ctx, {
      requestId: args.requestId,
      text: args.text,
      conversationId: args.conversationId,
      status: args.status,
      error: args.error,
      skipAssistantMessage: args.skipAssistantMessage,
      rescuedByWatchdog: true,
    });
    return null;
  },
});
