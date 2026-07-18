import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { AgentModelConfigSnapshot } from "../../../contracts/agent-engine.js";
import type { RecallLookupResult } from "../../agent-runtime/recall-run-cache.js";
import type { ToolDefinition } from "../types.js";

export type RecallToolOptions = {
  contextProvider?: (payload: {
    conversationId: string;
    requestId: string;
    runId?: string;
    prompt: string;
    memorySearchTerms?: string[];
    agentType?: string;
    modelConfigSnapshot?: AgentModelConfigSnapshot;
    signal?: AbortSignal;
  }) => Promise<RecallLookupResult>;
};

export const createRecallTool = (
  options: RecallToolOptions,
): ToolDefinition => ({
  name: "Recall",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  description:
    "Look up deeper memory, past work, or live machine context that isn't currently loaded. Recall routes by intent before reading: common repo/path/decision/exact-phrase lookups return indexed evidence directly with no model call; only genuine multi-source episodic questions use one light-tier synthesis call. Past work results include resumable thread_ids and source inbox/run ids. " +
    'Use it when the user references something from before ("yesterday", "that", "the thing I was doing"), asks about prior work, names a repo/module/feature with possible history, points at past agent threads to resume, or the request is ambiguous and earlier context could change the answer. ' +
    "You do NOT need it for the user's name, location, stable preferences, or current focus — those are already in your context. Skip it for self-contained requests (current time, simple rewrite, trivial formatting). When in doubt on anything historical or on-screen, do a quick Recall. The result has a structured status: found, no_match, retrieval_error, or synthesis_error. Do not blindly retry the same lookup after no_match or an error; identical same-run lookups are cached.",
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
          "Grep-like search terms: 2-8 concrete terms from the user's wording, repo/module names, feature names, dates, file names, error text, or prior-decision keywords. Recall chooses the relevant index first and permits at most one deterministic fallback pass.",
      },
    },
    required: ["prompt", "memorySearchTerms"],
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
    if (!memorySearchTerms?.length) {
      return {
        error:
          "memorySearchTerms is required: pass 2-8 concrete grep-like terms (names, repo/module/feature words, dates, file names, error text) so the lookup can pre-run its searches.",
      };
    }
    const result = await options.contextProvider({
      conversationId: context.conversationId,
      requestId: context.requestId,
      ...(context.runId ? { runId: context.runId } : {}),
      prompt,
      ...(memorySearchTerms?.length ? { memorySearchTerms } : {}),
      ...(context.agentType ? { agentType: context.agentType } : {}),
      ...(context.modelConfigSnapshot
        ? { modelConfigSnapshot: context.modelConfigSnapshot }
        : {}),
      ...(extras?.signal ? { signal: extras.signal } : {}),
    });
    return { result };
  },
});
