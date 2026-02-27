import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

const WEBHOOK_EVENT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const rateLimitResponse = (retryAfterMs: number) =>
  new Response("Too Many Requests", {
    status: 429,
    headers: {
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
  const status = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
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
  ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
    scope: args.scope,
    key: args.key,
    limit: args.limit,
    windowMs: args.windowMs,
    blockMs: args.blockMs,
  });
