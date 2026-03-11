export type ModelDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

const MODEL_SETTINGS_METADATA: Record<string, { label: string; desc: string }> = {
  orchestrator: {
    label: "Orchestrator",
    desc: "Top-level agent that delegates tasks",
  },
  general: {
    label: "General",
    desc: "Full tool access for general tasks",
  },
  browser: {
    label: "Browser",
    desc: "Browser automation via Playwright",
  },
  explore: {
    label: "Explore",
    desc: "Lightweight read-only exploration",
  },
};

const MODEL_SETTINGS_ORDER = ["orchestrator", "general", "browser", "explore"] as const;

export function buildModelDefaultsMap(
  defaults: readonly ModelDefaultEntry[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const entry of defaults ?? []) {
    const agentType = entry.agentType.trim();
    const model = entry.model.trim();
    if (!agentType || !model) {
      continue;
    }
    map[agentType] = model;
  }

  return map;
}

export function buildResolvedModelDefaultsMap(
  defaults: readonly ModelDefaultEntry[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const entry of defaults ?? []) {
    const agentType = entry.agentType.trim();
    const model = entry.resolvedModel.trim();
    if (!agentType || !model) {
      continue;
    }
    map[agentType] = model;
  }

  return map;
}

export function getConfigurableAgents(
  defaults: readonly ModelDefaultEntry[] | undefined,
): Array<{ key: string; label: string; desc: string }> {
  const availableAgentTypes = new Set((defaults ?? []).map((entry) => entry.agentType));
  return MODEL_SETTINGS_ORDER
    .filter((agentType) => availableAgentTypes.has(agentType))
    .map((agentType) => ({
      key: agentType,
      label: MODEL_SETTINGS_METADATA[agentType].label,
      desc: MODEL_SETTINGS_METADATA[agentType].desc,
    }));
}

export function normalizeModelOverrides(
  overrides: Record<string, string>,
  defaultModels: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [agentType, value] of Object.entries(overrides)) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const defaultModel = defaultModels[agentType];
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
  defaultModels: Record<string, string>,
  resolvedDefaultModels: Record<string, string>,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  const defaultModel = defaultModels[agentType];
  if (!defaultModel) {
    return "Default";
  }

  const resolvedModel = resolvedDefaultModels[agentType] ?? defaultModel;
  const resolvedLabel = getModelDisplayLabel(resolvedModel, modelNamesById);
  if (defaultModel === "stella/default") {
    return `Stella Recommended (currently ${resolvedLabel})`;
  }

  return `Default (${resolvedLabel})`;
}
