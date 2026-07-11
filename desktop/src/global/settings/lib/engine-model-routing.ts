import type { CatalogModel } from "./model-catalog";

export type ModelPickerEngine = "default" | "codex_cli" | "claude_code_local";

export type EngineRoutingPreferences = {
  modelOverrides: Record<string, string>;
  stellaConversationModelOverrides: Record<string, string>;
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
  agentRuntimeEngine: ModelPickerEngine;
  reasoningEfforts: Record<string, EngineReasoningEffort>;
  stellaConversationReasoningEfforts: Record<string, EngineReasoningEffort>;
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

export type LiveCodexModel = {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
};

/** Only models accepted by both the OAuth orchestrator and Codex runtime. */
export function intersectChatGptModels(
  catalog: readonly CatalogModel[],
  liveModels: readonly LiveCodexModel[],
): CatalogModel[] {
  const liveIds = new Set(
    liveModels.filter((model) => !model.hidden).map((model) => model.id),
  );
  return listChatGptCatalogModels(catalog).filter((model) =>
    liveIds.has(model.modelId),
  );
}

export function normalizeClaudeCodeReasoningEffort(
  effort: EngineReasoningEffort,
): EngineReasoningEffort {
  return effort === "minimal" ? "low" : effort;
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
  const stellaOverrides = { ...preferences.stellaConversationModelOverrides };
  const nextPropagated = preferences.assistantPropagatedAgents.filter(
    (key) => !CONVERSATION_AGENT_KEYS.some((agentKey) => agentKey === key),
  );

  const missingStellaSnapshot = CONVERSATION_AGENT_KEYS.every(
    (key) => !stellaOverrides[key],
  );
  if (
    preferences.agentRuntimeEngine === "default" ||
    (preferences.agentRuntimeEngine === "codex_cli" && missingStellaSnapshot)
  ) {
    for (const key of CONVERSATION_AGENT_KEYS) {
      if (
        nextOverrides[key] &&
        fromOpenAiCodexModelId(nextOverrides[key]) === null
      ) {
        stellaOverrides[key] = nextOverrides[key];
      } else delete stellaOverrides[key];
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
      stellaConversationModelOverrides: stellaOverrides,
      assistantPropagatedAgents: nextPropagated,
    };
  }

  for (const key of CONVERSATION_AGENT_KEYS) {
    if (stellaOverrides[key]) nextOverrides[key] = stellaOverrides[key];
    else delete nextOverrides[key];
  }
  return {
    agentRuntimeEngine: engine,
    ...(engine === "claude_code_local" && modelId?.trim()
      ? { claudeCodeModel: modelId.trim() }
      : {}),
    modelOverrides: nextOverrides,
    stellaConversationModelOverrides: stellaOverrides,
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
  const stellaReasoning = {
    ...preferences.stellaConversationReasoningEfforts,
  };

  if (engine === "default") {
    for (const key of agentKeys) {
      if (effort === "default") delete nextReasoning[key];
      else nextReasoning[key] = effort;
    }
    for (const key of agentKeys) {
      if (nextReasoning[key]) stellaReasoning[key] = nextReasoning[key];
      else delete stellaReasoning[key];
    }
    return {
      reasoningEfforts: nextReasoning,
      stellaConversationReasoningEfforts: stellaReasoning,
    };
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
    claudeCodeReasoningEffort: normalizeClaudeCodeReasoningEffort(effort),
  };
}

export function buildEngineTransitionReasoningPatch(
  preferences: EngineReasoningPreferences,
  engine: ModelPickerEngine,
): Partial<EngineReasoningPreferences> {
  const next = { ...preferences.reasoningEfforts };
  const stellaReasoning = {
    ...preferences.stellaConversationReasoningEfforts,
  };
  if (preferences.agentRuntimeEngine === "default") {
    for (const key of CONVERSATION_AGENT_KEYS) {
      const effort = next[key];
      if (effort && effort !== "default") stellaReasoning[key] = effort;
      else delete stellaReasoning[key];
    }
  }
  if (engine === "default") {
    for (const key of CONVERSATION_AGENT_KEYS) {
      const effort = preferences.stellaConversationReasoningEfforts[key];
      if (effort && effort !== "default") next[key] = effort;
      else delete next[key];
    }
  } else if (engine === "codex_cli") {
    delete next.general;
    if (preferences.codexReasoningEffort === "default")
      delete next.orchestrator;
    else next.orchestrator = preferences.codexReasoningEffort;
  } else {
    delete next.orchestrator;
    delete next.general;
  }
  return {
    reasoningEfforts: next,
    stellaConversationReasoningEfforts: stellaReasoning,
  };
}
