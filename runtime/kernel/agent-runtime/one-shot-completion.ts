/**
 * Generic one-shot text completion driven by the runtime's BYOK-aware route
 * resolver. Used by renderer surfaces that previously rolled their own
 * `callChatCompletion`/Convex-action call (task progress summaries, the
 * music-prompt shaper, etc.) so the user's per-agent model override + local
 * provider credentials are honored just like the orchestrator and
 * subsidiary agents.
 *
 * Resolution order for `agentType`:
 *   1. Explicit `modelOverrides[agentType]` (e.g. user picked a model for
 *      this agent specifically).
 *   2. `defaultModels[agentType]` (filled in by Settings → Models defaults).
 *   3. Any `fallbackAgentTypes` (in order) — lets internal helpers like
 *      `task_summary` and `music_prompt` ride the user's Assistant-tab BYOK
 *      pick without being listed as user-configurable agents themselves.
 *   4. Stella's recommended default (managed gateway).
 *
 * Falls through to the Stella managed gateway whenever a non-Stella model
 * id has no matching local credential — same fallback semantics as
 * `resolveLlmRoute`.
 */

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type { Context, Message } from "../../ai/types.js";
import { resolveLlmRoute } from "../model-routing.js";
import {
  getDefaultModel,
  getModelOverride,
} from "../preferences/local-preferences.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { createRuntimeLogger } from "../debug.js";
import type {
  RuntimeOneShotCompletionRequest,
  RuntimeOneShotCompletionResult,
} from "../../protocol/index.js";

const logger = createRuntimeLogger("agent-runtime.one-shot-completion");

export type OneShotCompletionRuntimeContext = {
  stellaRoot: string;
  siteBaseUrl: string | null;
  getAuthToken: () => string | null;
  requestRuntimeAuthRefresh?: () => Promise<{
    authenticated: boolean;
    token: string | null;
    hasConnectedAccount: boolean;
  } | null>;
};

const resolveModelName = (
  stellaRoot: string,
  agentType: string,
  fallbackAgentTypes: readonly string[] | undefined,
): string | undefined => {
  const direct =
    getModelOverride(stellaRoot, agentType) ??
    getDefaultModel(stellaRoot, agentType);
  if (direct) return direct;
  if (!fallbackAgentTypes) return undefined;
  for (const fallback of fallbackAgentTypes) {
    const override =
      getModelOverride(stellaRoot, fallback) ??
      getDefaultModel(stellaRoot, fallback);
    if (override) return override;
  }
  return undefined;
};

export const runOneShotCompletion = async (args: {
  request: RuntimeOneShotCompletionRequest;
  runtime: OneShotCompletionRuntimeContext;
}): Promise<RuntimeOneShotCompletionResult> => {
  const { request, runtime } = args;
  const userText = request.userText.trim();
  if (!userText) {
    return { text: "" };
  }

  const route = resolveLlmRoute({
    stellaRoot: runtime.stellaRoot,
    modelName: resolveModelName(
      runtime.stellaRoot,
      request.agentType,
      request.fallbackAgentTypes,
    ),
    agentType: request.agentType,
    site: {
      baseUrl: runtime.siteBaseUrl,
      getAuthToken: () => runtime.getAuthToken()?.trim() ?? null,
      refreshAuthToken: async () => {
        const result = await runtime.requestRuntimeAuthRefresh?.();
        return result?.authenticated ? result.token : null;
      },
    },
  });

  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: runtime.stellaRoot,
    modelId: route.model.id,
  });

  const apiKey = useClaudeCode
    ? undefined
    : (await route.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    throw new Error(
      "No API credential is available for this completion. Add a matching local key in Settings → Models or sign in to use Stella.",
    );
  }

  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];
  const context: Context = {
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    messages,
  };

  try {
    if (useClaudeCode) {
      const text = await runClaudeCodeAgentTextCompletion({
        stellaRoot: runtime.stellaRoot,
        agentType: request.agentType,
        context,
      });
      return { text: text.trim() };
    }
    const response = await completeSimple(route.model, context, {
      apiKey,
      ...(request.maxOutputTokens != null
        ? { maxTokens: request.maxOutputTokens }
        : {}),
      ...(request.temperature != null
        ? { temperature: request.temperature }
        : {}),
    });
    return { text: readAssistantText(response) };
  } catch (error) {
    logger.debug("one-shot.completion.failed", {
      agentType: request.agentType,
      provider: route.model.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
