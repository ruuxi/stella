/**
 * Internal hook system — centralized lifecycle hooks for chat infrastructure.
 *
 * Provides rate limiting, usage logging, and token tracking at well-defined
 * lifecycle points. These are infrastructure-level hooks (not user-facing
 * plugins) that keep lifecycle logic out of the main request handlers.
 */
import { internalMutation, internalQuery } from '../_generated/server'
import type { ActionCtx, MutationCtx } from '../_generated/server'
import { components, internal } from '../_generated/api'
import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { RateLimiter } from '@convex-dev/rate-limiter'
import { persistManagedUsage } from '../billing'

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

const chatRateLimiter = new RateLimiter(components.rateLimiter)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AfterChatParams = {
  ownerId: string
  conversationId: Id<'conversations'>
  agentType: string
  modelString: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  durationMs: number
  success: boolean
  fallbackUsed?: boolean
}

export type AfterToolParams = {
  ownerId: string
  conversationId: Id<'conversations'>
  agentType: string
  toolName: string
  durationMs: number
  success: boolean
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

// 30 requests per minute per owner
const CHAT_RATE_LIMIT = 30
const CHAT_RATE_WINDOW_MS = 60_000
const USAGE_ROLLUP_BUCKET_MS = 60_000

type UsageRollupDelta = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  requestCount?: number
  toolCallCount?: number
}

const toRollupCount = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

const addUsageRollup = async (
  ctx: MutationCtx,
  ownerId: string,
  createdAt: number,
  delta: UsageRollupDelta,
) => {
  const bucketStartMs =
    Math.floor(createdAt / USAGE_ROLLUP_BUCKET_MS) * USAGE_ROLLUP_BUCKET_MS
  const existing = await ctx.db
    .query('usage_rollups')
    .withIndex('by_ownerId_and_bucketStartMs', (q) =>
      q.eq('ownerId', ownerId).eq('bucketStartMs', bucketStartMs),
    )
    .unique()
  const inputTokens = toRollupCount(delta.inputTokens)
  const outputTokens = toRollupCount(delta.outputTokens)
  const totalTokens = toRollupCount(delta.totalTokens)
  const requestCount = toRollupCount(delta.requestCount)
  const toolCallCount = toRollupCount(delta.toolCallCount)

  if (existing) {
    await ctx.db.patch(existing._id, {
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
      totalTokens: existing.totalTokens + totalTokens,
      requestCount: existing.requestCount + requestCount,
      toolCallCount: existing.toolCallCount + toolCallCount,
      updatedAt: createdAt,
    })
    return
  }

  await ctx.db.insert('usage_rollups', {
    ownerId,
    bucketStartMs,
    inputTokens,
    outputTokens,
    totalTokens,
    requestCount,
    toolCallCount,
    updatedAt: createdAt,
  })
}

export const checkChatRateLimit = internalMutation({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const status = await chatRateLimiter.limit(
      ctx,
      `chat:rate:${CHAT_RATE_LIMIT}:${CHAT_RATE_WINDOW_MS}`,
      {
        key: args.ownerId,
        config: {
          kind: 'fixed window',
          rate: CHAT_RATE_LIMIT,
          period: CHAT_RATE_WINDOW_MS,
        },
      },
    )

    if (status.ok) {
      return { allowed: true }
    }

    return {
      allowed: false,
      reason:
        'Rate limit exceeded. Please wait before sending another message.',
      retryAfterMs: Math.max(1_000, status.retryAfter ?? CHAT_RATE_WINDOW_MS),
    }
  },
})

// ---------------------------------------------------------------------------
// afterChat — usage logging + token tracking
// ---------------------------------------------------------------------------

/**
 * Fire afterChat hook from an ActionCtx. Handles usage logging and
 * conversation token count patching.
 */
export async function afterChat(
  ctx: ActionCtx,
  params: AfterChatParams,
): Promise<void> {
  // Log usage asynchronously (fire-and-forget via scheduler)
  await ctx.scheduler.runAfter(0, internal.agent.hooks.logUsage, {
    ownerId: params.ownerId,
    conversationId: params.conversationId,
    agentType: params.agentType,
    model: params.modelString,
    inputTokens: params.usage?.inputTokens,
    outputTokens: params.usage?.outputTokens,
    totalTokens: params.usage?.totalTokens,
    durationMs: params.durationMs,
    success: params.success,
    fallbackUsed: params.fallbackUsed,
  })
}

// ---------------------------------------------------------------------------
// afterToolExecution — lightweight tool audit
// ---------------------------------------------------------------------------

/**
 * Fire afterToolExecution hook. Uses scheduler to log asynchronously
 * so it doesn't add latency to the tool call path.
 */
export async function afterToolExecution(
  ctx: ActionCtx,
  params: AfterToolParams,
): Promise<void> {
  // Fire-and-forget — don't block the tool response
  await ctx.scheduler.runAfter(0, internal.agent.hooks.logToolExecution, {
    ownerId: params.ownerId,
    conversationId: params.conversationId,
    agentType: params.agentType,
    toolName: params.toolName,
    durationMs: params.durationMs,
    success: params.success,
  })
}

// ---------------------------------------------------------------------------
// Internal Mutations (called via ctx.runMutation / ctx.scheduler.runAfter)
// ---------------------------------------------------------------------------

export const logUsage = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id('conversations'),
    agentType: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    durationMs: v.number(),
    success: v.boolean(),
    fallbackUsed: v.optional(v.boolean()),
    toolCalls: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now()
    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      durationMs: args.durationMs,
      success: args.success,
      fallbackUsed: args.fallbackUsed,
      toolCalls: args.toolCalls,
    })
    await addUsageRollup(ctx, args.ownerId, createdAt, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens:
        args.totalTokens ?? (args.inputTokens ?? 0) + (args.outputTokens ?? 0),
      requestCount: 1,
    })
    return null
  },
})

export const logToolExecution = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id('conversations'),
    agentType: v.string(),
    toolName: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now()
    // Lightweight logging — insert a minimal usage_logs entry for tool tracking.
    // Using the same table avoids schema sprawl; toolName is stored in the model field.
    await ctx.db.insert('usage_logs', {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      model: `tool:${args.toolName}`,
      durationMs: args.durationMs,
      success: args.success,
      createdAt,
    })
    await addUsageRollup(ctx, args.ownerId, createdAt, { toolCallCount: 1 })
    return null
  },
})

/**
 * Log proxy usage — called from the transparent LLM proxy (httpAction).
 * Does not require a conversationId since proxy requests are stateless.
 * Logs to usage_logs with a synthetic conversationId if none is available.
 */
export const logProxyUsage = internalMutation({
  args: {
    ownerId: v.string(),
    agentType: v.string(),
    model: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    estimateFromRequest: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now()
    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      agentType: `proxy:${args.agentType}`,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: (args.inputTokens ?? 0) + (args.outputTokens ?? 0),
      durationMs: args.durationMs,
      success: args.success,
    })
    await addUsageRollup(ctx, args.ownerId, createdAt, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: (args.inputTokens ?? 0) + (args.outputTokens ?? 0),
      requestCount: 1,
    })
    return null
  },
})

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

/**
 * Get aggregated usage for an owner over a recent time window.
 *
 * `nowMs` must be supplied by the caller (typically `Date.now()` from an
 * action / httpAction). Computing it inside the query handler would defeat
 * Convex's reactive cache — every subscriber would re-run on every read.
 */
export const getOwnerUsage = internalQuery({
  args: {
    ownerId: v.string(),
    nowMs: v.number(),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const windowMs = args.windowMs ?? 24 * 60 * 60 * 1000 // 24h default
    const since = args.nowMs - windowMs

    const sinceBucket =
      Math.floor(since / USAGE_ROLLUP_BUCKET_MS) * USAGE_ROLLUP_BUCKET_MS
    const maxBuckets = Math.min(
      2000,
      Math.ceil(windowMs / USAGE_ROLLUP_BUCKET_MS) + 2,
    )
    const rollups = await ctx.db
      .query('usage_rollups')
      .withIndex('by_ownerId_and_bucketStartMs', (q) =>
        q.eq('ownerId', args.ownerId).gte('bucketStartMs', sinceBucket),
      )
      .take(maxBuckets)

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalTokens = 0
    let requestCount = 0
    let toolCallCount = 0

    for (const rollup of rollups) {
      totalInputTokens += rollup.inputTokens
      totalOutputTokens += rollup.outputTokens
      totalTokens += rollup.totalTokens
      requestCount += rollup.requestCount
      toolCallCount += rollup.toolCallCount
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      requestCount,
      toolCallCount,
    }
  },
})
