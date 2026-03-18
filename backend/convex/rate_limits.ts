import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { hashSha256Hex } from "./lib/crypto_utils";

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

const webhookRateLimiter = new RateLimiter(components.rateLimiter);

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

export const consumeWebhookRateLimit = internalMutation({
  args: {
    scope: v.string(),
    key: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    blockMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.floor(args.limit));
    const periodMs = Math.max(1_000, Math.floor(args.windowMs), Math.floor(args.blockMs ?? 0));
    const hashedKey = await hashSha256Hex(`${args.scope}:${args.key}`);
    const status = await webhookRateLimiter.limit(ctx, `webhook:${args.scope}:${limit}:${periodMs}`, {
      key: hashedKey,
      config: { kind: "fixed window", rate: limit, period: periodMs },
    });

    return status.ok
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: Math.max(1_000, status.retryAfter ?? periodMs) };
  },
});
