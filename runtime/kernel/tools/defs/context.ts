import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolDefinition } from "../types.js";

export type ContextToolOptions = {
  contextProvider?: (payload: {
    conversationId: string;
    requestId: string;
    prompt: string;
    memorySearchTerms?: string[];
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
    "Look up memory or context you might have but isn't currently loaded. Use when the user references something from before (\"yesterday\", \"that thing\", \"the one I was doing\") or you suspect there's relevant memory, prior activity, or screen/browser context that could resolve what they mean. Reads from durable memory, recent activity, active threads, and current app/browser state. Provide memorySearchTerms when durable memory may contain the answer; Stella will search memory files locally and include matching lines in the lookup.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "What you're trying to remember or resolve, in your own words. e.g. \"what was the user working on yesterday afternoon\" or \"what does the user mean by 'that PR'\".",
      },
      memorySearchTerms: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional grep-like search terms for durable memory files. Use 2-8 concrete terms from the user's wording, repo/module names, feature names, dates, file names, error text, or prior decision keywords.",
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
    const memorySearchTerms = Array.isArray(args.memorySearchTerms)
      ? args.memorySearchTerms
          .filter((term): term is string => typeof term === "string")
          .map((term) => term.trim())
          .filter(Boolean)
      : undefined;
    const result = await options.contextProvider({
      conversationId: context.conversationId,
      requestId: context.requestId,
      prompt,
      ...(memorySearchTerms?.length ? { memorySearchTerms } : {}),
      ...(context.agentType ? { agentType: context.agentType } : {}),
      ...(extras?.signal ? { signal: extras.signal } : {}),
    });
    return { result };
  },
});
