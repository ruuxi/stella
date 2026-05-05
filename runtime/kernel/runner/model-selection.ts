import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import {
  canResolveLlmRoute,
  resolveLlmRoute,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import type { RunnerContext } from "./types.js";

export const createRunnerSiteConfig = (context: RunnerContext) => ({
  baseUrl: context.state.convexSiteUrl,
  getAuthToken: () => context.state.authToken?.trim(),
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
): ResolvedLlmRoute =>
  resolveLlmRoute({
    stellaRoot: context.stellaRoot,
    modelName,
    agentType,
    site: createRunnerSiteConfig(context),
  });

export const resolveRunnerLlmRouteWithMetadata = async (
  context: RunnerContext,
  agentType: string,
  modelName: string | undefined,
): Promise<ResolvedLlmRoute> => {
  const site = createRunnerSiteConfig(context);
  const route = resolveLlmRoute({
    stellaRoot: context.stellaRoot,
    modelName,
    agentType,
    site,
  });
  return await withStellaModelCatalogMetadata({
    route,
    agentType,
    site,
    deviceId: context.deviceId,
    modelCatalogUpdatedAt: context.state.modelCatalogUpdatedAt,
  });
};

export const canResolveRunnerLlmRoute = (
  context: RunnerContext,
  modelName: string | undefined,
  agentType = AGENT_IDS.ORCHESTRATOR,
): boolean =>
  canResolveLlmRoute({
    stellaRoot: context.stellaRoot,
    modelName,
    agentType,
    site: createRunnerSiteConfig(context),
  });
