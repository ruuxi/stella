import type { CatalogModel } from "./model-catalog";

export type ModelPickerEngine = "default" | "codex_cli" | "claude_code_local";

export type EngineRoutingPreferences = {
  modelOverrides: Record<string, string>;
  assistantPropagatedAgents: string[];
  agentRuntimeEngine: ModelPickerEngine;
  codexModel: string;
  claudeCodeModel: string;
};

export type EngineReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type EngineReasoningPreferences = {
  reasoningEfforts: Record<string, EngineReasoningEffort>;
  codexReasoningEffort: EngineReasoningEffort;
  claudeCodeReasoningEffort: EngineReasoningEffort;
};

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CHATGPT_MODEL = "gpt-5.4";
export const DEFAULT_CLAUDE_CODE_MODEL = "default";

const CONVERSATION_AGENT_KEYS = ["orchestrator", "general"] as const;

export function listChatGptCatalogModels(
  models: readonly CatalogModel[],
): CatalogModel[] {
  return models.filter((model) => model.provider === OPENAI_CODEX_PROVIDER);
}

export function toOpenAiCodexModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith(`${OPENAI_CODEX_PROVIDER}/`)
    ? trimmed
    : `${OPENAI_CODEX_PROVIDER}/${trimmed}`;
}

export function fromOpenAiCodexModelId(modelId: string): string | null {
  const prefix = `${OPENAI_CODEX_PROVIDER}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : null;
}

/**
 * Build the single preference write that changes the runtime engine and its
 * conversation model routing. ChatGPT is intentionally asymmetric:
 * orchestrator resolves through the existing OpenAI OAuth provider, while
 * general is intercepted by the Codex runtime through `agentRuntimeEngine`.
 * Both overrides stay routable so preparation succeeds before the general
 * agent hands off to Codex.
 */
export function buildEngineRoutingPatch(
  preferences: EngineRoutingPreferences,
  engine: ModelPickerEngine,
  modelId?: string,
): Partial<EngineRoutingPreferences> {
  const nextOverrides = { ...preferences.modelOverrides };
  const nextPropagated = preferences.assistantPropagatedAgents.filter(
    (key) => !CONVERSATION_AGENT_KEYS.some((agentKey) => agentKey === key),
  );

  for (const key of CONVERSATION_AGENT_KEYS) {
    if (fromOpenAiCodexModelId(nextOverrides[key] ?? "") !== null) {
      delete nextOverrides[key];
    }
  }

  if (engine === "codex_cli") {
    const selectedModel = modelId?.trim() || preferences.codexModel;
    const routeModel = toOpenAiCodexModelId(selectedModel);
    nextOverrides.orchestrator = routeModel;
    nextOverrides.general = routeModel;
    return {
      agentRuntimeEngine: engine,
      codexModel: selectedModel,
      modelOverrides: nextOverrides,
      assistantPropagatedAgents: nextPropagated,
    };
  }

  return {
    agentRuntimeEngine: engine,
    ...(engine === "claude_code_local" && modelId?.trim()
      ? { claudeCodeModel: modelId.trim() }
      : {}),
    modelOverrides: nextOverrides,
    assistantPropagatedAgents: nextPropagated,
  };
}

export function buildEngineReasoningPatch(
  preferences: EngineReasoningPreferences,
  engine: ModelPickerEngine,
  effort: EngineReasoningEffort,
  agentKeys: readonly string[],
): Partial<EngineReasoningPreferences> {
  const nextReasoning = { ...preferences.reasoningEfforts };

  if (engine === "default") {
    for (const key of agentKeys) {
      if (effort === "default") delete nextReasoning[key];
      else nextReasoning[key] = effort;
    }
    return { reasoningEfforts: nextReasoning };
  }

  if (engine === "codex_cli") {
    delete nextReasoning.general;
    if (effort === "default") delete nextReasoning.orchestrator;
    else nextReasoning.orchestrator = effort;
    return {
      reasoningEfforts: nextReasoning,
      codexReasoningEffort: effort,
    };
  }

  for (const key of agentKeys) delete nextReasoning[key];
  return {
    reasoningEfforts: nextReasoning,
    claudeCodeReasoningEffort: effort,
  };
}
