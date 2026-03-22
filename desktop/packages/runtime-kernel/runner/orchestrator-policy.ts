import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import { canResolveRunnerLlmRoute } from "./model-selection.js";
import { sanitizeStellaBase } from "./shared.js";
import type {
  AgentHealth,
  ChatPayload,
  RunnerContext,
} from "./types.js";
import type { RuntimeAttachmentRef } from "../../runtime-protocol/index.js";

export type OrchestratorRuntimeDeps = {
  resolveAgent: (agentType: string) => unknown;
  getConfiguredModel: (
    agentType: string,
    agent?: unknown,
  ) => string | undefined;
};

export type NormalizedOrchestratorRunInput = {
  conversationId: string;
  userPrompt: string;
  attachments: RuntimeAttachmentRef[];
  agentType: string;
};

const normalizeAttachments = (
  attachments: ChatPayload["attachments"],
): RuntimeAttachmentRef[] =>
  Array.isArray(attachments)
    ? attachments.filter(
        (attachment): attachment is RuntimeAttachmentRef =>
          Boolean(
            attachment &&
              typeof attachment.url === "string" &&
              attachment.url.trim().length > 0,
          ),
      )
    : [];

export const getOrchestratorHealth = (
  context: RunnerContext,
  deps: OrchestratorRuntimeDeps,
): AgentHealth => {
  if (!context.state.isRunning) {
    return {
      ready: false,
      reason: "Stella runtime is not started",
      engine: "stella",
    };
  }
  if (!context.state.isInitialized) {
    return {
      ready: false,
      reason: "Stella runtime is still initializing",
      engine: "stella",
    };
  }
  const orchestratorModel = deps.getConfiguredModel(
    AGENT_IDS.ORCHESTRATOR,
    deps.resolveAgent(AGENT_IDS.ORCHESTRATOR),
  );
  if (canResolveRunnerLlmRoute(context, orchestratorModel)) {
    return { ready: true, engine: "pi" };
  }
  const hasProxyUrl = Boolean(sanitizeStellaBase(context.state.proxyBaseUrl));
  const hasAuthToken = Boolean(context.state.authToken?.trim());
  if (!hasProxyUrl) {
    return { ready: false, reason: "Missing proxy URL", engine: "pi" };
  }
  if (!hasAuthToken) {
    return { ready: false, reason: "Missing auth token", engine: "pi" };
  }
  return { ready: false, reason: "No usable model route", engine: "pi" };
};

export const normalizeChatRunInput = (
  payload: ChatPayload,
): NormalizedOrchestratorRunInput => ({
  conversationId: payload.conversationId,
  userPrompt: payload.userPrompt.trim(),
  attachments: normalizeAttachments(payload.attachments),
  agentType: payload.agentType ?? AGENT_IDS.ORCHESTRATOR,
});

export const normalizeAutomationRunInput = (payload: {
  conversationId: string;
  userPrompt: string;
  agentType?: string;
}): NormalizedOrchestratorRunInput => ({
  conversationId: payload.conversationId.trim(),
  userPrompt: payload.userPrompt.trim(),
  attachments: [],
  agentType: payload.agentType ?? AGENT_IDS.ORCHESTRATOR,
});
