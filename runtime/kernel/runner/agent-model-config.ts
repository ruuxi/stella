import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type {
  AgentModelConfigSnapshot,
  AgentModelReasoningEffort,
  AgentRuntimeEngine,
  SpawnEngineSelection,
} from "../../contracts/agent-engine.js";
import { getCodexRuntimePreferences } from "../integrations/codex-agent-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
} from "../integrations/claude-code-agent-runtime.js";
import type { ResolvedLlmRoute } from "../model-routing.js";

export const normalizeCapturedReasoningEffort = (
  value: string | undefined,
): AgentModelReasoningEffort | undefined => {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
};

export const exactRouteModelReference = (
  resolvedLlm: ResolvedLlmRoute,
  configuredModel: string | undefined,
): string => {
  if (resolvedLlm.route === "stella") {
    const upstreamModel = (
      resolvedLlm.model as ResolvedLlmRoute["model"] & {
        upstreamModelId?: string;
      }
    ).upstreamModelId;
    const resolvedModel =
      resolvedLlm.toolPolicyModel?.id.trim() ||
      upstreamModel?.trim() ||
      resolvedLlm.model.id.trim();
    return `stella/${resolvedModel}`;
  }
  if (configuredModel?.trim()) return configuredModel.trim();
  const id = resolvedLlm.model.id.trim();
  return id.includes("/") ? id : `${resolvedLlm.model.provider}/${id}`;
};

export const captureEffectiveModelConfig = (args: {
  stellaDataDir: string;
  engine: AgentRuntimeEngine;
  configuredModel?: string;
  engineModelOverride?: string;
  resolvedLlm: ResolvedLlmRoute;
  reasoningEffort?: string;
}): AgentModelConfigSnapshot => {
  const routeModel = exactRouteModelReference(
    args.resolvedLlm,
    args.configuredModel,
  );
  if (args.engine === "codex_cli") {
    const codex = getCodexRuntimePreferences(
      args.stellaDataDir,
      args.configuredModel,
      args.engineModelOverride,
    );
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      normalizeCapturedReasoningEffort(codex.reasoningEffort);
    return {
      engine: args.engine,
      routeModel,
      engineModel: codex.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  if (args.engine === "claude_code_local") {
    const model = getClaudeCodeAgentModelId(
      args.stellaDataDir,
      args.configuredModel,
      AGENT_IDS.ORCHESTRATOR,
      args.engineModelOverride,
    ).replace(/^claude-code\//, "");
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      normalizeCapturedReasoningEffort(
        getClaudeCodeRuntimeEffortLevel(args.stellaDataDir),
      );
    return {
      engine: args.engine,
      routeModel,
      engineModel: model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  const effort = normalizeCapturedReasoningEffort(args.reasoningEffort);
  return {
    engine: args.engine,
    routeModel,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
};

export const resolveAgentEngineForRun = (
  configuredEngine: AgentRuntimeEngine,
  spawnEngine?: SpawnEngineSelection,
): AgentRuntimeEngine => spawnEngine?.engine ?? configuredEngine;
