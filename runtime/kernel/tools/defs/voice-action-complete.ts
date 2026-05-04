import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

type VoiceActionCompleteOptions = {
  notifyVoiceActionComplete?: (payload: {
    conversationId: string;
    status: "completed" | "failed";
    message: string;
  }) => Promise<void> | void;
};

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const createVoiceActionCompleteTool = (
  options: VoiceActionCompleteOptions,
): ToolDefinition => ({
  name: "voice_result",
  description:
    "Notify the live voice agent that a delegated voice action is genuinely complete or failed. Use this only for voice-originated work that has reached a real terminal state.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "failed"],
        description: "Whether the requested action completed successfully or failed.",
      },
      message: {
        type: "string",
        description:
          "Short natural-language result for the voice agent to tell the user.",
      },
    },
    required: ["status", "message"],
  },
  execute: async (args, context) => {
    const denied = requireOrchestrator("voice_result", context);
    if (denied) return denied;

    const status = asTrimmedString(args.status);
    const message = asTrimmedString(args.message);
    if (status !== "completed" && status !== "failed") {
      return { error: 'status must be "completed" or "failed".' };
    }
    if (!message) {
      return { error: "message is required." };
    }
    if (!options.notifyVoiceActionComplete) {
      return { error: "Voice action notifications are not available." };
    }

    await options.notifyVoiceActionComplete({
      conversationId: context.conversationId,
      status,
      message,
    });

    return {
      result: `Voice action marked ${status}. The voice agent has been notified.`,
    };
  },
});
