import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { AgentModelConfigSnapshot } from "../../contracts/agent-engine.js";
import { getAgentRuntimeEngine } from "../preferences/local-preferences.js";
import {
  RECALL_CLAUDE_CODE_MODEL,
  RECALL_CLAUDE_PROVIDER_MODEL,
  RECALL_CODEX_PROVIDER_MODEL,
  RECALL_STELLA_MODEL,
  type RecallModelRoute,
} from "../agent-runtime/recall-route.js";
import {
  canResolveLlmRoute,
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import type { RunnerContext } from "./types.js";

export const createRunnerSiteConfig = (context: RunnerContext) => ({
  baseUrl: context.state.convexSiteUrl,
  getAuthToken: () => context.state.authToken?.trim(),
  hasConnectedAccount: () => context.state.hasConnectedAccount,
  refreshAuthToken: async () => {
    const result = await context.requestRuntimeAuthRefresh?.({
      source: "stella_provider",
    });
    return result?.authenticated ? result.token : null;
  },
});

export const resolveRunnerLlmRoute = (
  context: RunnerContext,
  agentType: string,
  modelName: string | undefined,
  reasoningEffort?: string,
): ResolvedLlmRoute =>
  resolveLlmRoute({
    stellaAppDir: context.stellaDataDir,
    modelName,
    agentType,
    site: createRunnerSiteConfig(context),
    reasoningEffort,
  });

export const resolveRunnerLlmRouteWithMetadata = async (
  context: RunnerContext,
  agentType: string,
  modelName: string | undefined,
  reasoningEffort?: string,
): Promise<ResolvedLlmRoute> => {
  const site = createRunnerSiteConfig(context);
  const route = resolveLlmRouteForCatalogEnrichment({
    stellaAppDir: context.stellaDataDir,
    modelName,
    agentType,
    site,
    reasoningEffort,
  });
  return await withStellaModelCatalogMetadata({
    route,
    agentType,
    site,
    deviceId: context.deviceId,
    modelCatalogUpdatedAt: context.state.modelCatalogUpdatedAt,
    stellaDataDir: context.stellaDataDir,
    reasoningEffort,
  });
};

/** Resolve Recall's authoritative light tier from the active orchestrator engine. */
export const resolveRunnerRecallLlmRoute = async (
  context: RunnerContext,
  agentType: string,
  modelConfigSnapshot?: AgentModelConfigSnapshot,
): Promise<RecallModelRoute> => {
  const activeEngine =
    modelConfigSnapshot?.engine ?? getAgentRuntimeEngine(context.stellaDataDir);
  if (activeEngine === "claude_code_local") {
    try {
      const resolvedLlm = resolveRunnerLlmRoute(
        context,
        agentType,
        RECALL_CLAUDE_PROVIDER_MODEL,
      );
      return {
        activeEngine,
        executionEngine: "native",
        modelId: `${resolvedLlm.model.provider}/${resolvedLlm.model.id}`,
        resolvedLlm,
      };
    } catch {
      // Claude Code subscription auth belongs to the CLI and is not exposed
      // as an Anthropic provider credential. Fall back to the authoritative
      // Haiku CLI route when no independent provider credential is present.
    }
    return {
      activeEngine,
      executionEngine: "claude-code",
      modelId: `claude-code/${RECALL_CLAUDE_CODE_MODEL}`,
      claudeCodeModel: RECALL_CLAUDE_CODE_MODEL,
    };
  }
  if (activeEngine === "codex_cli") {
    const resolvedLlm = resolveRunnerLlmRoute(
      context,
      agentType,
      RECALL_CODEX_PROVIDER_MODEL,
    );
    return {
      activeEngine,
      executionEngine: "native",
      modelId: `${resolvedLlm.model.provider}/${resolvedLlm.model.id}`,
      resolvedLlm,
    };
  }
  const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
    context,
    agentType,
    RECALL_STELLA_MODEL,
  );
  return {
    activeEngine,
    executionEngine: "native",
    modelId: RECALL_STELLA_MODEL,
    resolvedLlm,
  };
};

export const canResolveRunnerLlmRoute = (
  context: RunnerContext,
  modelName: string | undefined,
  agentType = AGENT_IDS.ORCHESTRATOR,
): boolean =>
  canResolveLlmRoute({
    stellaAppDir: context.stellaDataDir,
    modelName,
    agentType,
    site: createRunnerSiteConfig(context),
  });
