import { shouldIncludeStellaDocumentation } from "../../../src/shared/contracts/agent-runtime.js";
import { buildSelfModDocumentationPrompt, buildSystemPrompt } from "./thread-memory.js";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "./types.js";

export const createUserPromptMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

export const buildRuntimeSystemPrompt = async (
  opts: OrchestratorRunOptions,
): Promise<string> => {
  let effectiveSystemPrompt = buildSystemPrompt(opts.agentContext);
  if (!opts.hookEmitter) {
    return effectiveSystemPrompt;
  }

  const hookResult = await opts.hookEmitter.emit(
    "before_agent_start",
    { agentType: opts.agentType, systemPrompt: effectiveSystemPrompt },
    { agentType: opts.agentType },
  );
  if (hookResult?.systemPromptReplace) {
    return hookResult.systemPromptReplace;
  }
  if (hookResult?.systemPromptAppend) {
    return `${effectiveSystemPrompt}\n${hookResult.systemPromptAppend}`;
  }
  return effectiveSystemPrompt;
};

export const buildSubagentSystemPrompt = (
  opts: SubagentRunOptions,
): string =>
  [
    buildSystemPrompt(opts.agentContext),
    shouldIncludeStellaDocumentation(opts.agentType)
      ? buildSelfModDocumentationPrompt(opts.frontendRoot)
      : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
