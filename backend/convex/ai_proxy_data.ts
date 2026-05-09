/**
 * Data access for AI proxy rate limiting (anon_device_usage table).
 */

import { ConvexError, v } from 'convex/values'
import { internalQuery, internalMutation } from './_generated/server'
import { hashSha256Hex } from './lib/crypto_utils'
import { clampIntToRange } from './lib/number_utils'

const DEVICE_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/

const normalizeClientAddressKey = (value: string | undefined) => {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CLIENT_ADDRESS_KEY_LENGTH ||
    !CLIENT_ADDRESS_KEY_PATTERN.test(normalized)
  ) {
    return undefined
  }
  return normalized
}

async function hashDeviceId(
  deviceId: string,
  clientAddressKey?: string,
): Promise<string> {
  const salt = process.env.ANON_DEVICE_ID_HASH_SALT?.trim()
  if (!salt) {
    throw new ConvexError('Missing ANON_DEVICE_ID_HASH_SALT')
  }
  const normalizedAddressKey = normalizeClientAddressKey(clientAddressKey)
  const materialBase = normalizedAddressKey
    ? `${deviceId}|addr:${normalizedAddressKey}`
    : deviceId
  const material = `${salt}:${materialBase}`
  const hashHex = await hashSha256Hex(material)
  return `sha256:${hashHex}`
}

/**
 * `nowMs` is supplied by the caller so the staleness check is deterministic
 * — calling `Date.now()` inside a query handler would invalidate Convex's
 * reactive cache on every read.
 */
export const getDeviceUsage = internalQuery({
  args: {
    deviceId: v.string(),
    nowMs: v.number(),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
    const row = await ctx.db
      .query('anon_device_usage')
      .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
      .unique()
    if (!row) return null
    if (args.nowMs - row.lastRequestAt > DEVICE_USAGE_RETENTION_MS) {
      return null
    }
    return {
      requestCount: row.requestCount,
      firstRequestAt: row.firstRequestAt,
      lastRequestAt: row.lastRequestAt,
    }
  },
})

export const incrementDeviceUsage = internalMutation({
  args: {
    deviceId: v.string(),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
    const existing = await ctx.db
      .query('anon_device_usage')
      .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
      .unique()

    const now = Date.now()

    if (existing) {
      const stale = now - existing.lastRequestAt > DEVICE_USAGE_RETENTION_MS
      await ctx.db.patch(existing._id, {
        requestCount: stale ? 1 : existing.requestCount + 1,
        firstRequestAt: stale ? now : existing.firstRequestAt,
        lastRequestAt: now,
      })
    } else {
      await ctx.db.insert('anon_device_usage', {
        deviceId: deviceHash,
        requestCount: 1,
        firstRequestAt: now,
        lastRequestAt: now,
      })
    }

    return null
  },
})

/**
 * Atomically checks and consumes one anonymous request allowance.
 */
export const consumeDeviceAllowance = internalMutation({
  args: {
    deviceId: v.string(),
    maxRequests: v.number(),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const maxRequests = clampIntToRange(
      args.maxRequests,
      1,
      Number.MAX_SAFE_INTEGER,
    )
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
    const existing = await ctx.db
      .query('anon_device_usage')
      .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
      .unique()

    const now = Date.now()
    let requestCount = 1
    let firstRequestAt = now

    if (existing) {
      const stale = now - existing.lastRequestAt > DEVICE_USAGE_RETENTION_MS
      requestCount = stale ? 1 : existing.requestCount + 1
      firstRequestAt = stale ? now : existing.firstRequestAt
      await ctx.db.patch(existing._id, {
        requestCount,
        firstRequestAt,
        lastRequestAt: now,
      })
    } else {
      await ctx.db.insert('anon_device_usage', {
        deviceId: deviceHash,
        requestCount,
        firstRequestAt,
        lastRequestAt: now,
      })
    }

    return {
      allowed: requestCount <= maxRequests,
      requestCount,
      remaining: Math.max(0, maxRequests - requestCount),
      firstRequestAt,
      lastRequestAt: now,
    }
  },
})
