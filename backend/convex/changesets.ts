import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const getByChangeSetId = async (ctx: MutationCtx, changeSetId: string) => {
  const existing = await ctx.db
    .query("changesets")
    .withIndex("by_change_set", (q) => q.eq("changeSetId", changeSetId))
    .take(1);
  return existing[0] ?? null;
};

const sanitizeChangeSetForClient = (record: Record<string, unknown> | null) => {
  if (!record) return null;
  // ChangeSets must not leak provider/model identifiers; none are stored here,
  // but we still strip any unexpected keys defensively.
  const {
    changeSetId,
    scope,
    agentType,
    status,
    reason,
    title,
    summary,
    baselineId,
    gitHeadAtStart,
    gitHeadAtEnd,
    diffPatch,
    diffPatchTruncated,
    changedFiles,
    instructionInvariants,
    instructionNotes,
    blockReasons,
    guardFailures,
    validations,
    validationSummary,
    rollbackApplied,
    rollbackReason,
    lastError,
    conversationId,
    deviceId,
    startedAt,
    completedAt,
    updatedAt,
    _id,
    _creationTime,
  } = record as Record<string, unknown>;
  return {
    _id,
    _creationTime,
    changeSetId,
    scope,
    agentType,
    status,
    reason,
    title,
    summary,
    baselineId,
    gitHeadAtStart,
    gitHeadAtEnd,
    diffPatch,
    diffPatchTruncated,
    changedFiles,
    instructionInvariants,
    instructionNotes,
    blockReasons,
    guardFailures,
    validations,
    validationSummary,
    rollbackApplied,
    rollbackReason,
    lastError,
    conversationId,
    deviceId,
    startedAt,
    completedAt,
    updatedAt,
  };
};

export const start = mutation({
  args: {
    changeSetId: v.string(),
    scope: v.string(),
    agentType: v.string(),
    startedAt: v.number(),
    baselineId: v.optional(v.string()),
    gitHeadAtStart: v.optional(v.string()),
    reason: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await getByChangeSetId(ctx, args.changeSetId);
    const payload = {
      changeSetId: args.changeSetId,
      scope: args.scope,
      agentType: args.agentType,
      status: "active",
      reason: args.reason,
      baselineId: args.baselineId,
      gitHeadAtStart: args.gitHeadAtStart,
      conversationId: args.conversationId,
      deviceId: args.deviceId,
      startedAt: args.startedAt,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      const patched = await ctx.db.get(existing._id);
      return sanitizeChangeSetForClient(patched as any);
    }

    const id = await ctx.db.insert("changesets", payload as any);
    const created = await ctx.db.get(id);
    return sanitizeChangeSetForClient(created as any);
  },
});

export const complete = mutation({
  args: {
    changeSetId: v.string(),
    status: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    baselineId: v.optional(v.string()),
    gitHeadAtEnd: v.optional(v.string()),
    diffPatch: v.optional(v.string()),
    diffPatchTruncated: v.optional(v.boolean()),
    changedFiles: v.any(),
    instructionInvariants: v.optional(v.any()),
    instructionNotes: v.optional(v.any()),
    blockReasons: v.optional(v.any()),
    guardFailures: v.optional(v.any()),
    validations: v.optional(v.any()),
    validationSummary: v.optional(v.any()),
    rollbackApplied: v.optional(v.boolean()),
    rollbackReason: v.optional(v.string()),
    lastError: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await getByChangeSetId(ctx, args.changeSetId);
    const payload = {
      changeSetId: args.changeSetId,
      status: args.status,
      title: args.title,
      summary: args.summary,
      baselineId: args.baselineId,
      gitHeadAtEnd: args.gitHeadAtEnd,
      diffPatch: args.diffPatch,
      diffPatchTruncated: args.diffPatchTruncated,
      changedFiles: args.changedFiles,
      instructionInvariants: args.instructionInvariants,
      instructionNotes: args.instructionNotes,
      blockReasons: args.blockReasons,
      guardFailures: args.guardFailures,
      validations: args.validations,
      validationSummary: args.validationSummary,
      rollbackApplied: args.rollbackApplied,
      rollbackReason: args.rollbackReason,
      lastError: args.lastError,
      conversationId: args.conversationId,
      deviceId: args.deviceId,
      completedAt: args.completedAt,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload as any);
      const patched = await ctx.db.get(existing._id);
      return sanitizeChangeSetForClient(patched as any);
    }

    const id = await ctx.db.insert("changesets", {
      changeSetId: args.changeSetId,
      scope: "unknown",
      agentType: "unknown",
      status: args.status,
      startedAt: now,
      ...payload,
    } as any);
    const created = await ctx.db.get(id);
    return sanitizeChangeSetForClient(created as any);
  },
});

export const mark_rolled_back = mutation({
  args: {
    changeSetId: v.string(),
    reason: v.optional(v.string()),
    rolledBackAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await getByChangeSetId(ctx, args.changeSetId);
    const payload = {
      status: "rolled_back",
      rollbackApplied: true,
      rollbackReason: args.reason,
      completedAt: args.rolledBackAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      const patched = await ctx.db.get(existing._id);
      return sanitizeChangeSetForClient(patched as any);
    }

    const id = await ctx.db.insert("changesets", {
      changeSetId: args.changeSetId,
      scope: "unknown",
      agentType: "unknown",
      status: "rolled_back",
      startedAt: now,
      ...payload,
    } as any);
    const created = await ctx.db.get(id);
    return sanitizeChangeSetForClient(created as any);
  },
});

export const rollback_to_baseline = mutation({
  args: {
    baselineId: v.string(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("safe_mode_events", {
      bootId: `baseline:${args.baselineId}:${args.createdAt}`,
      status: "baseline_rollback",
      safeModeApplied: true,
      smokePassed: true,
      reason: args.reason,
      deviceId: args.deviceId,
      checkedAt: args.createdAt,
    });
    return { ok: true };
  },
});

export const safe_mode_status = mutation({
  args: {
    bootId: v.string(),
    status: v.string(),
    safeModeApplied: v.boolean(),
    smokePassed: v.boolean(),
    reason: v.optional(v.string()),
    smokeFailures: v.optional(v.array(v.string())),
    checkedAt: v.number(),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("safe_mode_events")
      .withIndex("by_boot", (q) => q.eq("bootId", args.bootId))
      .take(1);

    const payload = {
      bootId: args.bootId,
      status: args.status,
      safeModeApplied: args.safeModeApplied,
      smokePassed: args.smokePassed,
      reason: args.reason,
      smokeFailures: args.smokeFailures,
      deviceId: args.deviceId,
      checkedAt: args.checkedAt,
    };

    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, payload);
      return await ctx.db.get(existing[0]._id);
    }

    const id = await ctx.db.insert("safe_mode_events", payload);
    return await ctx.db.get(id);
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const records = await ctx.db
      .query("changesets")
      .withIndex("by_updated")
      .order("desc")
      .take(200);
    return records.map((record) => sanitizeChangeSetForClient(record as any));
  },
});

export const listByConversation = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("changesets")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(200);
    return records.map((record) => sanitizeChangeSetForClient(record as any));
  },
});
