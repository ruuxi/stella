import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { persistManagedUsage } from "./billing";
import { dollarsToMicroCents } from "./lib/billing_money";

export const MEDIA_REALTIME_ENDPOINT_ID = "fal-ai/flux-2/klein/realtime";
const MEDIA_REALTIME_PRICE_PER_SECOND_USD = 0.00194;
export const MEDIA_REALTIME_HEARTBEAT_TIMEOUT_MS = 15_000;

const getRealtimeSession = async (
  ctx: MutationCtx,
  ownerId: string,
  sessionId: string,
) => await ctx.db
  .query("media_realtime_sessions")
  .withIndex("by_ownerId_and_sessionId", (q) =>
    q.eq("ownerId", ownerId).eq("sessionId", sessionId),
  )
  .unique();

export const syncSessionActivity = internalMutation({
  args: {
    ownerId: v.string(),
    sessionId: v.string(),
    event: v.union(
      v.literal("start"),
      v.literal("heartbeat"),
      v.literal("stop"),
    ),
    endpointId: v.optional(v.string()),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    const sessionId = args.sessionId.trim();
    const endpointId = (args.endpointId ?? MEDIA_REALTIME_ENDPOINT_ID).trim();
    const observedAt = Math.max(0, Math.floor(args.observedAt ?? Date.now()));

    if (!ownerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "ownerId is required.",
      });
    }
    if (!sessionId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "sessionId is required.",
      });
    }
    if (endpointId !== MEDIA_REALTIME_ENDPOINT_ID) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Unsupported realtime media endpoint: ${endpointId}`,
      });
    }

    const existing = await getRealtimeSession(ctx, ownerId, sessionId);
    if (!existing && args.event !== "start") {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Realtime media session not found. Start a session before sending heartbeats.",
      });
    }
    if (existing?.status === "ended") {
      if (args.event === "stop") {
        return {
          sessionId,
          endpointId: existing.endpointId,
          status: "ended" as const,
          startedAt: existing.startedAt,
          lastSeenAt: existing.lastSeenAt,
          billedSeconds: existing.billedSeconds,
          newlyBilledSeconds: 0,
          costMicroCents: 0,
          expired: false,
        };
      }
      throw new ConvexError({
        code: "CONFLICT",
        message: "Realtime media session has already ended. Start a new session with a new sessionId.",
      });
    }

    const startedAt = existing?.startedAt ?? observedAt;
    const previousBilledSeconds = existing?.billedSeconds ?? 0;
    const lastSeenAt = existing?.lastSeenAt ?? observedAt;
    const timedOut =
      existing !== null &&
      observedAt - lastSeenAt > MEDIA_REALTIME_HEARTBEAT_TIMEOUT_MS;
    const effectiveObservedAt = timedOut
      ? lastSeenAt + MEDIA_REALTIME_HEARTBEAT_TIMEOUT_MS
      : observedAt;
    const elapsedWholeSeconds = Math.max(
      0,
      Math.floor((effectiveObservedAt - startedAt) / 1000),
    );
    const billedSeconds = Math.max(previousBilledSeconds, elapsedWholeSeconds);
    const newlyBilledSeconds = Math.max(0, billedSeconds - previousBilledSeconds);
    const costMicroCents = dollarsToMicroCents(
      newlyBilledSeconds * MEDIA_REALTIME_PRICE_PER_SECOND_USD,
    );
    const status =
      args.event === "stop" || timedOut ? "ended" as const : "active" as const;

    if (newlyBilledSeconds > 0) {
      await persistManagedUsage(ctx, {
        ownerId,
        agentType: "service:media:realtime",
        model: endpointId,
        durationMs: newlyBilledSeconds * 1000,
        success: true,
        costMicroCents,
      });
    }

    const patch = {
      endpointId,
      status,
      startedAt,
      lastSeenAt: effectiveObservedAt,
      billedSeconds,
      updatedAt: effectiveObservedAt,
      ...(status === "ended" ? { endedAt: effectiveObservedAt } : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("media_realtime_sessions", {
        ownerId,
        sessionId,
        createdAt: effectiveObservedAt,
        ...patch,
      });
    }

    return {
      sessionId,
      endpointId,
      status,
      startedAt,
      lastSeenAt: effectiveObservedAt,
      billedSeconds,
      newlyBilledSeconds,
      costMicroCents,
      expired: timedOut,
    };
  },
});
