import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { runAgentTurn } from "../automation/runner";
import { requireConversationOwner } from "../auth";

export type ExecutionCandidate =
  | { mode: "local"; targetDeviceId: string }
  | { mode: "cloud" };

export const buildExecutionCandidates = (args: {
  targetDeviceId?: string | null;
}): ExecutionCandidate[] => {
  const candidates: ExecutionCandidate[] = [];
  if (args.targetDeviceId) {
    candidates.push({ mode: "local", targetDeviceId: args.targetDeviceId });
  }

  // Local-first scheduler policy: local -> cloud.
  candidates.push({ mode: "cloud" });
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

export const runAgentTurnWithFallback = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  prompt: string;
  agentType: string;
  ownerId: string;
  transient?: boolean;
  candidates: ExecutionCandidate[];
}) => {
  let result = null as Awaited<ReturnType<typeof runAgentTurn>> | null;
  let lastExecutionError: Error | null = null;

  for (const candidate of args.candidates) {
    try {
      result = await runAgentTurn({
        ctx: args.ctx,
        conversationId: args.conversationId,
        prompt: args.prompt,
        agentType: args.agentType,
        ownerId: args.ownerId,
        targetDeviceId: candidate.mode === "local" ? candidate.targetDeviceId : undefined,
        transient: args.transient,
      });
      break;
    } catch (error) {
      lastExecutionError = error as Error;
    }
  }

  if (!result) {
    throw lastExecutionError ?? new Error("No execution candidate succeeded");
  }
  return result;
};
