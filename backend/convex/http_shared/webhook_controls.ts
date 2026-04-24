import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { withCors } from "./cors";

const WEBHOOK_EVENT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const rateLimitResponse = (retryAfterMs: number) =>
  new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    },
  });

export const consumeWebhookDedup = async (
  ctx: Pick<ActionCtx, "runMutation">,
  scope: string,
  key: string | null | undefined,
): Promise<boolean> => {
  if (!key || key.trim().length === 0) {
    return true;
  }
  const status = await ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
    scope: `${scope}_dedup`,
    key,
    limit: 1,
    windowMs: WEBHOOK_EVENT_DEDUP_WINDOW_MS,
    blockMs: WEBHOOK_EVENT_DEDUP_WINDOW_MS,
  });
  return status.allowed;
};

export const consumeWebhookRateLimit = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    scope: string;
    key: string;
    limit: number;
    windowMs: number;
    blockMs: number;
  },
) =>
  ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
    scope: args.scope,
    key: args.key,
    limit: args.limit,
    windowMs: args.windowMs,
    blockMs: args.blockMs,
  });

export const enforceHttpRateLimit = async (
  ctx: Pick<ActionCtx, "runMutation">,
  origin: string | null,
  args: {
    scope: string;
    key: string;
    limit: number;
    windowMs: number;
    blockMs: number;
  },
): Promise<Response | null> => {
  const status = await consumeWebhookRateLimit(ctx, args);
  return status.allowed ? null : withCors(rateLimitResponse(status.retryAfterMs), origin);
};
