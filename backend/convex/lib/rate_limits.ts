/**
 * Shared rate-limit helpers for public Convex mutations and actions.
 *
 * Why this exists: the desktop/mobile clients are user-modifiable, so the
 * backend has to enforce every quota itself. Public functions that touch
 * paid third-party APIs (Stripe, Cloudflare, fal, OpenAI), spend Convex
 * storage/transaction budget, send messages to other users, or mutate
 * security-sensitive state should call into here with a per-owner key so a
 * compromised or malicious client can't churn them.
 *
 * Two entry points are provided so callers don't have to think about the
 * Convex runtime split:
 *   - `enforceMutationRateLimit` runs the limiter inline and is suitable
 *     for `mutation` / `internalMutation` handlers.
 *   - `enforceActionRateLimit` routes through the shared
 *     `internal.rate_limits.consumeWebhookRateLimit` helper because
 *     actions can't talk to the rate-limiter component directly.
 *
 * Both surface a uniform `ConvexError({ code: "RATE_LIMITED", retryAfterMs })`
 * so clients can render a single error path.
 */

import { RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { components, internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";

const sharedRateLimiter = new RateLimiter(components.rateLimiter);

export type RateLimitConfig = {
  /** Max requests permitted in `periodMs`. Must be >= 1. */
  rate: number;
  /** Window length in milliseconds. Must be >= 1000. */
  periodMs: number;
};

const DEFAULT_RATE_LIMIT_MESSAGE =
  "Too many requests. Please try again in a moment.";

const buildRateLimitError = (message: string, retryAfterMs?: number) =>
  new ConvexError({
    code: "RATE_LIMITED",
    message,
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
  });

/**
 * Enforce a per-key rate limit inside a Convex mutation. Throws a
 * `RATE_LIMITED` ConvexError when the bucket is exhausted.
 */
export const enforceMutationRateLimit = async (
  ctx: MutationCtx,
  scope: string,
  key: string,
  config: RateLimitConfig,
  message?: string,
): Promise<void> => {
  const rate = Math.max(1, Math.floor(config.rate));
  const periodMs = Math.max(1_000, Math.floor(config.periodMs));
  const status = await sharedRateLimiter.limit(ctx, scope, {
    key,
    config: { kind: "fixed window", rate, period: periodMs },
  });
  if (!status.ok) {
    throw buildRateLimitError(
      message ?? DEFAULT_RATE_LIMIT_MESSAGE,
      status.retryAfter,
    );
  }
};

/**
 * Enforce a per-key rate limit inside a Convex action by routing through
 * the shared `consumeWebhookRateLimit` internal mutation.
 */
export const enforceActionRateLimit = async (
  ctx: ActionCtx,
  scope: string,
  key: string,
  config: RateLimitConfig,
  message?: string,
): Promise<void> => {
  const rate = Math.max(1, Math.floor(config.rate));
  const periodMs = Math.max(1_000, Math.floor(config.periodMs));
  const result = await ctx.runMutation(
    internal.rate_limits.consumeWebhookRateLimit,
    {
      scope,
      key,
      limit: rate,
      windowMs: periodMs,
      blockMs: periodMs,
    },
  );
  if (!result.allowed) {
    throw buildRateLimitError(
      message ?? DEFAULT_RATE_LIMIT_MESSAGE,
      result.retryAfterMs,
    );
  }
};

// ---------------------------------------------------------------------------
// Standardized rate budgets
// ---------------------------------------------------------------------------
//
// These named tiers keep call sites consistent so it's easy to reason about
// what kind of usage a given function is allowed to do. Pick the smallest
// tier that still leaves room for legitimate UI/runtime behavior.

/** Hot-path mutations (heartbeats, presence, room reads, turn lifecycle). */
export const RATE_HOT_PATH: RateLimitConfig = { rate: 120, periodMs: 10_000 };

/** Standard authenticated user actions (send message, create record). */
export const RATE_STANDARD: RateLimitConfig = { rate: 30, periodMs: 10_000 };

/** Settings/preferences toggles. */
export const RATE_SETTINGS: RateLimitConfig = { rate: 60, periodMs: 60_000 };

/** Expensive third-party calls (LLM, web search/fetch, Cloudflare, Stripe). */
export const RATE_EXPENSIVE: RateLimitConfig = { rate: 30, periodMs: 60_000 };

/** Very expensive / costly actions (SMS, store package release, large LLM jobs). */
export const RATE_VERY_EXPENSIVE: RateLimitConfig = { rate: 10, periodMs: 60_000 };

/** Destructive or sensitive ops (account reset, session revocation, secret churn). */
export const RATE_SENSITIVE: RateLimitConfig = { rate: 5, periodMs: 60_000 };
