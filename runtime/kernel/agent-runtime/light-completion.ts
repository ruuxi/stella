/**
 * One-shot text completion on the engine-aware light tier.
 *
 * `resolveRunnerRecallLlmRoute` (runner/model-selection.ts) picks the light
 * model for whichever engine is active — DeepSeek flash on Stella, Haiku on
 * Claude Code, Luna on Codex — so callers never pin a model themselves. This
 * runs a single stateless turn on that route: no session, no thread history,
 * no tools, no run events, no persisted messages.
 *
 * For short derived text (the self-mod commit-subject namer, Recall's brief
 * synthesis) this is the whole job. Standing up a `SubagentSession` instead
 * would re-send the calling thread's entire transcript to produce a line.
 */

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type { Context, Message } from "../../ai/types.js";
import { runClaudeCodeAgentTextCompletion } from "../integrations/claude-code-agent-runtime.js";
import type { RecallModelRoute } from "./recall-route.js";

export const runLightTextCompletion = async (args: {
  route: RecallModelRoute;
  userPrompt: string;
  agentType: string;
  /** App dir — the Claude Code CLI's working directory. Never the data dir. */
  stellaAppDir: string;
  /** Data dir — where model/effort preferences live. */
  stellaDataDir: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<string> => {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: args.userPrompt }],
      timestamp: Date.now(),
    },
  ];
  const context: Context = {
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    messages,
  };

  if (args.route.executionEngine === "claude-code") {
    const text = await runClaudeCodeAgentTextCompletion({
      stellaAppDir: args.stellaDataDir,
      cwd: args.stellaAppDir,
      agentType: args.agentType,
      ...(args.route.claudeCodeModel
        ? { modelOverride: args.route.claudeCodeModel }
        : {}),
      effortLevel: "low",
      context: { ...context, tools: [] },
      ...(args.signal ? { abortSignal: args.signal } : {}),
    });
    return text.trim();
  }

  const resolvedLlm = args.route.resolvedLlm;
  if (!resolvedLlm) {
    throw new Error("Light-tier model route is unavailable.");
  }
  const apiKey = (await resolvedLlm.getApiKey())?.trim();
  if (!apiKey) {
    throw new Error("No light-tier model credential is configured.");
  }
  const response = await completeSimple(resolvedLlm.model, context, {
    apiKey,
    reasoning: "low",
    temperature: 0,
    ...(resolvedLlm.refreshApiKey
      ? { refreshApiKey: resolvedLlm.refreshApiKey }
      : {}),
    ...(args.maxOutputTokens != null
      ? { maxTokens: args.maxOutputTokens }
      : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? response.stopReason);
  }
  return readAssistantText(response).trim();
};
