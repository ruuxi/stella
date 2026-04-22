import { mutation, internalMutation, type MutationCtx } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwner } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
} from "../lib/rate_limits";

/**
 * Backend cron scheduling was removed. The remaining responsibility here is
 * completing cron-originated remote turn requests that were already handed to
 * a desktop device before the backend scheduler was retired.
 */
export const BACKEND_CRON_RUNTIME_REMOVED = true;

type CompleteCronTurnStatus = "ok" | "error";

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Invalid or missing remote_turn_request",
    });
  }
  if (request.conversationId !== args.conversationId) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Conversation mismatch" });
  }

  const requestPayload = request.payload as Record<string, unknown>;
  if (requestPayload.source !== "cron") {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Request is not a cron remote turn",
    });
  }

  if (request.requestState === "fulfilled") {
    return;
  }

  const now = Date.now();
  if (request.requestState !== "claimed") {
    await ctx.db.patch(request._id, {
      requestState: "claimed",
      claimedAt: now,
    });
  }

  const deliver = requestPayload.deliver as boolean | undefined;
  if (
    status === "ok" &&
    !args.skipAssistantMessage &&
    (deliver ?? true) &&
    trimmedText.length > 0
  ) {
    await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp: now,
      type: "assistant_message",
      payload: {
        text: trimmedText,
        source: "cron",
        cronJobId: asOptionalString(requestPayload.cronJobId),
        cronJobName: asOptionalString(requestPayload.cronJobName),
        sessionTarget: asOptionalString(requestPayload.sessionTarget),
      },
    });
  }

  await ctx.db.patch(request._id, {
    requestState: "fulfilled",
    fulfilledAt: now,
  });

  if (status === "error" && args.error) {
    // Persist the error inline on the request payload so callers can
    // surface it without poking at separate event rows.
    const nextPayload = {
      ...(requestPayload as Record<string, unknown>),
      lastError: args.error,
      ...(args.rescuedByWatchdog ? { rescuedByWatchdog: true } : {}),
    };
    await ctx.db.patch(request._id, { payload: nextPayload });
  } else if (args.rescuedByWatchdog) {
    const nextPayload = {
      ...(requestPayload as Record<string, unknown>),
      rescuedByWatchdog: true,
    };
    await ctx.db.patch(request._id, { payload: nextPayload });
  }
}

export const completeCronTurnResult = mutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await requireConversationOwner(ctx, args.conversationId);
    await enforceMutationRateLimit(
      ctx,
      "cron_complete_turn_result",
      conversation.ownerId,
      RATE_HOT_PATH,
    );
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
