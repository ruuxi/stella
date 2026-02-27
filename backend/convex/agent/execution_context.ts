import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

export const coerceDeviceContext = async (
  ctx: ActionCtx,
  args: {
    conversationId?: Id<"conversations">;
    userMessageId?: Id<"events">;
    targetDeviceId?: string;
  },
) => {
  const conversationId = args.conversationId;
  const userMessageId = args.userMessageId;
  let targetDeviceId = args.targetDeviceId;

  if (!targetDeviceId && userMessageId) {
    try {
      const userEvent = await ctx.runQuery(internal.events.getById, { id: userMessageId });
      if (userEvent?.deviceId) {
        targetDeviceId = userEvent.deviceId;
      }
    } catch {
      // Ignore lookup failures.
    }
  }

  if (!conversationId || !userMessageId || !targetDeviceId) {
    return null;
  }

  return { conversationId, userMessageId, targetDeviceId };
};
