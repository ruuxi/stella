import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolDefinition } from "../types.js";

export type ContextToolOptions = {
  contextProvider?: (payload: {
    conversationId: string;
    requestId: string;
    prompt: string;
    agentType?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
};

export const createContextTool = (
  options: ContextToolOptions,
): ToolDefinition => ({
  name: "Context",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  description:
    "Look up memory or context you might have but isn't currently loaded. Use when the user references something from before (\"yesterday\", \"that thing\", \"the one I was doing\") or you suspect there's relevant memory, prior activity, or screen/browser context that could resolve what they mean. Reads from durable memory, recent activity, active threads, and current app/browser state.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "What you're trying to remember or resolve, in your own words. e.g. \"what was the user working on yesterday afternoon\" or \"what does the user mean by 'that PR'\".",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  execute: async (args, context, extras) => {
    if (!options.contextProvider) {
      return { error: "Context lookup is not available in this runtime." };
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      return { error: "Context prompt is required." };
    }
    const result = await options.contextProvider({
      conversationId: context.conversationId,
      requestId: context.requestId,
      prompt,
      ...(context.agentType ? { agentType: context.agentType } : {}),
      ...(extras?.signal ? { signal: extras.signal } : {}),
    });
    return { result };
  },
});
