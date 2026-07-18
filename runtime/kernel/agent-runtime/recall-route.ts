import type { AgentRuntimeEngine } from "../../contracts/agent-engine.js";
import type { ResolvedLlmRoute } from "../model-routing.js";

/** Managed Stella light tier used only by Recall. */
export const RECALL_STELLA_MODEL = "stella/deepseek/deepseek-v4-flash";
/** Claude Code's `haiku` alias resolves to Claude Haiku 4.5. */
export const RECALL_CLAUDE_CODE_MODEL = "haiku";
/** Direct Anthropic route used when Stella already has an Anthropic credential. */
export const RECALL_CLAUDE_PROVIDER_MODEL = "anthropic/claude-haiku-4-5";
/** Direct ChatGPT/OpenAI-provider route; never the Codex CLI or Stella relay. */
export const RECALL_CODEX_PROVIDER_MODEL = "openai-codex/gpt-5.6-luna";

export type RecallModelRoute = {
  activeEngine: AgentRuntimeEngine;
  executionEngine: "claude-code" | "native";
  /** Exact model identity emitted in Recall telemetry. */
  modelId: string;
  /** Present for in-process provider execution (Stella and Codex/ChatGPT). */
  resolvedLlm?: ResolvedLlmRoute;
  /** Authoritative engine-native Claude model, immune to saved preferences. */
  claudeCodeModel?: string;
};
