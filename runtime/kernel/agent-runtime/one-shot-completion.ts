/**
 * Generic one-shot text completion driven by the runtime's BYOK-aware route
 * resolver. Used by renderer surfaces that previously rolled their own
 * `callChatCompletion`/Convex-action call (the music-prompt shaper, etc.) so
 * the user's per-agent model override + local provider credentials are
 * honored just like the orchestrator and subsidiary agents.
 *
 * Resolution order for `agentType`:
 *   1. Explicit `modelOverrides[agentType]` (e.g. user picked a model for
 *      this agent specifically).
 *   2. Any `fallbackAgentTypes` (in order) — lets internal helpers like
 *      `music_prompt` ride the user's Assistant-tab BYOK pick without being
 *      listed as user-configurable agents themselves.
 *   3. Stella's backend-owned default for the agent/audience.
 *
 * One-shot completions are non-interactive utility calls (connector
 * auto-replies, prompt shapers, …), so unlike the orchestrator they degrade
 * gracefully: a pick that can't be honored (`resolveLlmRoute` throws) falls
 * through to the next, broader candidate and ultimately to Stella's managed
 * default — rather than surfacing a hard error to the RPC caller.
 */

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type { Context, Message } from "../../ai/types.js";
import {
  resolveLlmRoute,
  resolvedLlmSupportsCredentiallessCalls,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import { getModelOverride } from "../preferences/local-preferences.js";
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
  stellaAppDir: string;
  stellaDataDir: string;
  siteBaseUrl: string | null;
  getAuthToken: () => string | null;
  hasConnectedAccount: () => boolean;
  requestRuntimeAuthRefresh?: () => Promise<{
    authenticated: boolean;
    token: string | null;
    hasConnectedAccount: boolean;
  } | null>;
};

const resolveModelName = (
  stellaDataDir: string,
  agentType: string,
  fallbackAgentTypes: readonly string[] | undefined,
): string | undefined => {
  const direct = getModelOverride(stellaDataDir, agentType);
  if (direct) return direct;
  if (!fallbackAgentTypes) return undefined;
  for (const fallback of fallbackAgentTypes) {
    const override = getModelOverride(stellaDataDir, fallback);
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

  const explicitModel = request.model?.trim() || undefined;
  const fallbackModelName = resolveModelName(
    runtime.stellaDataDir,
    request.agentType,
    request.fallbackAgentTypes,
  );
  const site = {
    baseUrl: runtime.siteBaseUrl,
    getAuthToken: () => runtime.getAuthToken()?.trim() ?? null,
    hasConnectedAccount: () => runtime.hasConnectedAccount(),
    refreshAuthToken: async () => {
      const result = await runtime.requestRuntimeAuthRefresh?.();
      return result?.authenticated ? result.token : null;
    },
  };
  const buildRoute = (modelName: string | undefined) =>
    resolveLlmRoute({
      stellaAppDir: runtime.stellaDataDir,
      modelName,
      agentType: request.agentType,
      site,
    });

  // Candidate model ids in priority order, most specific first:
  //   1. the explicit / inherited BYOK pick,
  //   2. the caller's `fallbackAgentTypes` pick,
  //   3. `undefined` → Stella's backend-chosen default (managed relay).
  // `resolveLlmRoute` now throws for a pick it can't honor (no key, unknown
  // model, unsupported provider); we catch and try the next, broader candidate
  // instead of letting the throw escape to the RPC caller. A route that
  // resolves but has no usable credential (e.g. a Stella alias while signed
  // out) likewise falls through.
  const candidateModelNames: (string | undefined)[] = [];
  for (const candidate of [
    explicitModel ?? fallbackModelName,
    fallbackModelName,
    undefined,
  ]) {
    if (!candidateModelNames.includes(candidate)) {
      candidateModelNames.push(candidate);
    }
  }

  let route: ResolvedLlmRoute | undefined;
  let modelName: string | undefined;
  let useClaudeCode = false;
  let apiKey: string | undefined;
  let lastRouteError: unknown;

  for (const candidate of candidateModelNames) {
    let candidateRoute: ResolvedLlmRoute | undefined;
    try {
      candidateRoute = buildRoute(candidate);
    } catch (error) {
      lastRouteError = error;
      // The Claude Code engine runs completions through the local CLI and
      // needs no resolvable LLM route or API credential. A candidate that
      // fails route resolution (e.g. `stella/light` while signed out on a
      // BYOK Claude Code setup) must still reach the engine check below —
      // otherwise progress summaries silently never run for CC users.
      if (
        !shouldUseClaudeCodeAgentRuntime({
          stellaAppDir: runtime.stellaDataDir,
          modelId: candidate,
        })
      ) {
        continue;
      }
    }
    const candidateUsesClaudeCode = shouldUseClaudeCodeAgentRuntime({
      stellaAppDir: runtime.stellaDataDir,
      modelId: candidateRoute?.model.id ?? candidate,
    });
    const candidateApiKey = candidateUsesClaudeCode
      ? undefined
      : (await candidateRoute?.getApiKey())?.trim();
    const usable =
      candidateUsesClaudeCode ||
      Boolean(candidateApiKey) ||
      (candidateRoute != null &&
        resolvedLlmSupportsCredentiallessCalls(candidateRoute));
    if (!usable) {
      continue;
    }
    route = candidateRoute;
    modelName = candidate;
    useClaudeCode = candidateUsesClaudeCode;
    apiKey = candidateApiKey;
    break;
  }

  if (!route && !useClaudeCode) {
    if (lastRouteError instanceof Error) {
      throw lastRouteError;
    }
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
        // Data dir, matching the other CC completion callers: preferences
        // (claudeCodeModel, reasoning effort) live under the data dir.
        stellaAppDir: runtime.stellaDataDir,
        agentType: request.agentType,
        ...(modelName ?? route?.model.id
          ? { stellaModel: (modelName ?? route?.model.id) as string }
          : {}),
        context,
      });
      return { text: text.trim() };
    }
    if (!route) {
      // Unreachable: a non-Claude-Code selection always carries a route.
      throw new Error("No usable model route was selected.");
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
      provider: useClaudeCode ? "claude-code" : route?.model.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
