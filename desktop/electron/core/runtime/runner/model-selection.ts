import { AGENT_IDS } from "../../../../src/shared/contracts/agent-runtime.js";
import {
  canResolveLlmRoute,
  resolveLlmRoute,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import type { RunnerContext } from "./types.js";

export const createRunnerProxyConfig = (context: RunnerContext) => ({
  baseUrl: context.state.proxyBaseUrl,
  getAuthToken: () => context.state.authToken?.trim(),
});

export const resolveRunnerLlmRoute = (
  context: RunnerContext,
  agentType: string,
  modelName: string | undefined,
): ResolvedLlmRoute =>
  resolveLlmRoute({
    stellaHomePath: context.stellaHomePath,
    modelName,
    agentType,
    proxy: createRunnerProxyConfig(context),
  });

export const canResolveRunnerLlmRoute = (
  context: RunnerContext,
  modelName: string | undefined,
  agentType = AGENT_IDS.ORCHESTRATOR,
): boolean =>
  canResolveLlmRoute({
    stellaHomePath: context.stellaHomePath,
    modelName,
    agentType,
    proxy: createRunnerProxyConfig(context),
  });

