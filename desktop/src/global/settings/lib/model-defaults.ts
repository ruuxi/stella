import { MODEL_SETTINGS_AGENTS } from "@/shared/contracts/agent-runtime";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";

export type ModelDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

export function getLocalModelDefaults(
  defaultModels: Record<string, string> | undefined,
  serverDefaults: readonly ModelDefaultEntry[] | undefined,
): ModelDefaultEntry[] {
  const serverDefaultByAgent = new Map(
    (serverDefaults ?? []).map((entry) => [entry.agentType, entry]),
  );

  return MODEL_SETTINGS_AGENTS.map((agent) => {
    const serverDefault = serverDefaultByAgent.get(agent.key);
    const model =
      defaultModels?.[agent.key] ??
      serverDefault?.model ??
      STELLA_DEFAULT_MODEL;
    return {
      agentType: agent.key,
      model,
      resolvedModel: serverDefault?.resolvedModel ?? model,
    };
  });
}

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
  if (defaults === undefined) {
    return [];
  }
  const availableAgentTypes = new Set(
    (defaults ?? []).map((entry) => entry.agentType),
  );
  return MODEL_SETTINGS_AGENTS.filter((agent) =>
    availableAgentTypes.has(agent.key),
  );
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

function getModelDisplayLabel(
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
