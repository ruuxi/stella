import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolDefinition } from "../types.js";

export type RecallToolOptions = {
  contextProvider?: (payload: {
    conversationId: string;
    requestId: string;
    prompt: string;
    memorySearchTerms?: string[];
    agentType?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
};

export const createRecallTool = (
  options: RecallToolOptions,
): ToolDefinition => ({
  name: "Recall",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  description:
    "Look up deeper memory, past work, or live machine context that isn't currently loaded. A recall agent searches the durable memory ledger, every past agent thread you've ever run (resumable — it returns thread_ids), recent activity, the chronicle, and the current app/browser state, then returns one concise brief. " +
    'Use it when the user references something from before ("yesterday", "that", "the thing I was doing"), asks about prior work, names a repo/module/feature with possible history, points at past agent threads to resume, or the request is ambiguous and earlier context could change the answer. ' +
    "You do NOT need it for the user's name, location, stable preferences, or current focus — those are already in your context. Skip it for self-contained requests (current time, simple rewrite, trivial formatting). When in doubt on anything historical or on-screen, do a quick Recall.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          'What you are trying to find or resolve, in your own words. e.g. "what was the user working on yesterday afternoon" or "find the thread where we set up the budget app".',
      },
      memorySearchTerms: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional grep-like search hints for the durable memory ledger: 2-8 concrete terms from the user's wording, repo/module names, feature names, dates, file names, error text, or prior decision keywords. The recall agent will also search on its own.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  execute: async (args, context, extras) => {
    if (!options.contextProvider) {
      return { error: "Recall is not available in this runtime." };
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      return { error: "Recall prompt is required." };
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
