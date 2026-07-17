import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import { shouldUseClaudeCodeAgentRuntime } from "../integrations/claude-code-agent-runtime.js";
import {
  canResolveLlmRoute,
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
  resolvedLlmSupportsCredentiallessCalls,
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

/**
 * Cheap pinned model for internal utility passes (Recall). Same pin the
 * renderer's progress-summary engine uses (`stella/light` — DeepSeek V4
 * Flash via the managed relay; the Claude Code engine maps it to its own
 * light model downstream).
 */
export const RUNNER_UTILITY_PINNED_MODEL = "stella/light";

/**
 * Resolve the route for an internal utility pass, pinned to
 * `RUNNER_UTILITY_PINNED_MODEL`. Candidate order mirrors
 * `runOneShotCompletion` (one-shot-completion.ts): the explicit cheap pin
 * first, then the caller's fallback model (the agent's own configured pick)
 * for signed-out / pure-BYOK users who can't resolve a `stella/*` route.
 *
 * A candidate is usable when it resolves AND either the Claude Code engine
 * handles it (no route credential needed), a credential is available, or the
 * route supports credentialless calls (local/direct provider with a baseUrl).
 * When no candidate is usable we resolve the fallback model verbatim so the
 * caller keeps the exact pre-pin behavior, including its failure modes.
 */
export const resolveRunnerUtilityLlmRoute = async (
  context: RunnerContext,
  agentType: string,
  fallbackModelName: string | undefined,
): Promise<ResolvedLlmRoute> => {
  const candidates = [RUNNER_UTILITY_PINNED_MODEL, fallbackModelName].filter(
    (candidate, index, all) => all.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    let route: ResolvedLlmRoute;
    try {
      route = resolveRunnerLlmRoute(context, agentType, candidate);
    } catch {
      continue;
    }
    // Engine check FIRST, on the synchronous credential-free route: the
    // Claude Code engine maps the pinned utility model to its own light
    // model downstream and needs neither a route credential nor catalog
    // metadata. Resolving metadata before this check put a network fetch
    // (the stella model catalog) on every utility pass even when the
    // engine never talks to the stella provider at all.
    if (
      shouldUseClaudeCodeAgentRuntime({
        stellaAppDir: context.stellaDataDir,
        modelId: route.model.id,
      })
    ) {
      return route;
    }
    let enriched: ResolvedLlmRoute;
    try {
      enriched = await resolveRunnerLlmRouteWithMetadata(
        context,
        agentType,
        candidate,
      );
    } catch {
      continue;
    }
    if (resolvedLlmSupportsCredentiallessCalls(enriched)) {
      return enriched;
    }
    const apiKey = (await enriched.getApiKey())?.trim();
    if (apiKey) return enriched;
  }
  return await resolveRunnerLlmRouteWithMetadata(
    context,
    agentType,
    fallbackModelName,
  );
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
