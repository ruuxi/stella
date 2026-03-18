import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { runAgentTurn } from "../automation/runner";
import { requireConversationOwner } from "../auth";

/**
 * Shared desktop handoff policy for backend-owned turns.
 *
 * Callers can prefer desktop execution when a device is online, then fall back
 * to backend execution if the handoff is unavailable or fails.
 */
export type DesktopTurnCandidate =
  | { mode: "desktop"; targetDeviceId: string }
  | { mode: "backend" };

export const buildDesktopTurnCandidates = (args: {
  targetDeviceId?: string | null;
}): DesktopTurnCandidate[] => {
  const candidates: DesktopTurnCandidate[] = [];
  if (args.targetDeviceId) {
    candidates.push({ mode: "desktop", targetDeviceId: args.targetDeviceId });
  }
  candidates.push({ mode: "backend" });
  return candidates;
};

export const resolveOwnedConversationId = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  conversationId?: Id<"conversations">,
): Promise<Id<"conversations"> | null> => {
  if (conversationId) {
    const conversation = await requireConversationOwner(ctx, conversationId);
    return conversation?._id ?? null;
  }
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_ownerId_and_isDefault", (q) => q.eq("ownerId", ownerId).eq("isDefault", true))
    .unique();
  return conversation?._id ?? null;
};

export const runAgentTurnWithBackendFallback = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  prompt: string;
  agentType: string;
  ownerId: string;
  transient?: boolean;
  candidates: DesktopTurnCandidate[];
  userMessageId?: Id<"events">;
}): Promise<{
  result: Awaited<ReturnType<typeof runAgentTurn>>;
  selectedMode: DesktopTurnCandidate["mode"];
}> => {
  let lastExecutionError: Error | null = null;

  for (const candidate of args.candidates) {
    try {
      const result = await runAgentTurn({
        ctx: args.ctx,
        conversationId: args.conversationId,
        prompt: args.prompt,
        agentType: args.agentType,
        ownerId: args.ownerId,
        transient: args.transient,
        userMessageId: args.userMessageId,
      });
      return { result, selectedMode: candidate.mode };
    } catch (error) {
      lastExecutionError = error as Error;
    }
  }

  throw lastExecutionError ?? new Error("No execution candidate succeeded");
};
