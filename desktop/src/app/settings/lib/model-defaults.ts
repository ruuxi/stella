export const AGENT_DEFAULT_MODEL_IDS: Record<string, string> = {
  orchestrator: "moonshotai/kimi-k2-0905:exacto",
  general: "moonshotai/kimi-k2-0905:exacto",
  self_mod: "moonshotai/kimi-k2-0905:exacto",
  browser: "openai/gpt-5.4",
  explore: "zai/glm-4.7",
  memory: "zai/glm-4.7",
};

export function getAgentDefaultModel(agentType: string): string | undefined {
  return AGENT_DEFAULT_MODEL_IDS[agentType];
}

export function normalizeModelOverrides(
  overrides: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [agentType, value] of Object.entries(overrides)) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const defaultModel = getAgentDefaultModel(agentType);
    if (defaultModel && trimmed === defaultModel) {
      continue;
    }

    normalized[agentType] = trimmed;
  }

  return normalized;
}

export function getModelDisplayLabel(
  modelId: string,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  return modelNamesById.get(modelId) ?? modelId;
}

export function getDefaultModelOptionLabel(
  agentType: string,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  const defaultModel = getAgentDefaultModel(agentType);
  if (!defaultModel) {
    return "Default";
  }

  return `Default (${getModelDisplayLabel(defaultModel, modelNamesById)})`;
}
