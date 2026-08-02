import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type {
  AgentModelConfigSnapshot,
  AgentModelReasoningEffort,
  AgentRuntimeEngine,
  CodexServiceTier,
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
  subscriptionHarnessEnabled?: boolean;
  configuredModel?: string;
  engineModelOverride?: string;
  serviceTierOverride?: CodexServiceTier;
  /** Engine preferences, including an intentional absent effort, were frozen. */
  engineConfigSampled?: boolean;
  resolvedLlm: ResolvedLlmRoute;
  reasoningEffort?: string;
}): AgentModelConfigSnapshot => {
  if (args.engine === "codex_cli") {
    const codex = getCodexRuntimePreferences(
      args.stellaDataDir,
      args.configuredModel,
      args.engineModelOverride,
    );
    // A first harnessed General turn has already resolved the effective Codex
    // provider route (including Stella-Light's mini-model downgrade). Keep
    // that exact provider model in the durable snapshot instead of resolving
    // preferences again from the transformed `openai-codex/...` route name.
    const codexModel =
      args.subscriptionHarnessEnabled &&
      args.resolvedLlm.model.provider === "openai-codex"
        ? args.resolvedLlm.model.id
        : codex.model;
    const routeModel = args.subscriptionHarnessEnabled
      ? `openai-codex/${codexModel}`
      : exactRouteModelReference(args.resolvedLlm, args.configuredModel);
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      (args.engineConfigSampled
        ? undefined
        : normalizeCapturedReasoningEffort(codex.reasoningEffort));
    return {
      engine: args.engine,
      ...(args.subscriptionHarnessEnabled
        ? { subscriptionHarnessEnabled: true }
        : {}),
      routeModel,
      engineModel: codexModel,
      ...(effort ? { reasoningEffort: effort } : {}),
      serviceTier: args.serviceTierOverride ?? codex.serviceTier,
    };
  }
  const routeModel = exactRouteModelReference(
    args.resolvedLlm,
    args.configuredModel,
  );
  if (args.engine === "claude_code_local") {
    const model = getClaudeCodeAgentModelId(
      args.stellaDataDir,
      args.configuredModel,
      AGENT_IDS.ORCHESTRATOR,
      args.engineModelOverride,
    ).replace(/^claude-code\//, "");
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      (args.engineConfigSampled
        ? undefined
        : normalizeCapturedReasoningEffort(
            getClaudeCodeRuntimeEffortLevel(args.stellaDataDir),
          ));
    return {
      engine: args.engine,
      ...(args.subscriptionHarnessEnabled
        ? { subscriptionHarnessEnabled: true }
        : {}),
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

export type SampledAgentEngineConfig = {
  engineModel?: string;
  reasoningEffort?: AgentModelReasoningEffort;
  serviceTier?: CodexServiceTier;
};

/** Freeze every engine-owned picker value before any async route lookup. */
export const sampleAgentEngineConfig = (args: {
  stellaDataDir: string;
  engine: AgentRuntimeEngine;
  configuredModel?: string;
  engineModelOverride?: string;
  reasoningEffort?: string;
}): SampledAgentEngineConfig => {
  const explicitEffort = normalizeCapturedReasoningEffort(args.reasoningEffort);
  if (args.engine === "codex_cli") {
    const codex = getCodexRuntimePreferences(
      args.stellaDataDir,
      args.configuredModel,
      args.engineModelOverride,
    );
    const effort =
      explicitEffort ?? normalizeCapturedReasoningEffort(codex.reasoningEffort);
    return {
      engineModel: codex.model,
      ...(effort ? { reasoningEffort: effort } : {}),
      serviceTier: codex.serviceTier,
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
      explicitEffort ??
      normalizeCapturedReasoningEffort(
        getClaudeCodeRuntimeEffortLevel(args.stellaDataDir),
      );
    return {
      engineModel: model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  return explicitEffort ? { reasoningEffort: explicitEffort } : {};
};

/**
 * Resolve the provider route required when a General Codex run is executed
 * by Stella's Pi harness. Orchestrator routing is deliberately excluded: its
 * existing execution path remains unchanged while its snapshot can still
 * carry the preference down to spawned General agents.
 */
export const resolveSubscriptionHarnessRouteModel = (args: {
  stellaDataDir: string;
  agentType: string;
  configuredEngine: AgentRuntimeEngine;
  subscriptionHarnessEnabled: boolean;
  configuredModel?: string;
  spawnEngine?: SpawnEngineSelection;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
}): string | undefined => {
  if (args.agentType === AGENT_IDS.ORCHESTRATOR) return undefined;
  const engine =
    args.modelConfigSnapshot?.engine ??
    resolveAgentEngineForRun(args.configuredEngine, args.spawnEngine);
  if (engine !== "codex_cli") return undefined;

  if (args.modelConfigSnapshot) {
    return args.modelConfigSnapshot.subscriptionHarnessEnabled === true
      ? args.modelConfigSnapshot.routeModel
      : undefined;
  }
  if (!args.subscriptionHarnessEnabled) return undefined;

  const codex = getCodexRuntimePreferences(
    args.stellaDataDir,
    args.configuredModel,
    args.spawnEngine?.engine === "codex_cli"
      ? args.spawnEngine.model
      : undefined,
  );
  return `openai-codex/${codex.model}`;
};
