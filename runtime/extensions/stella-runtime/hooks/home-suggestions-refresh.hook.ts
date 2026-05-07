import {
  AGENT_IDS,
  agentHasCapability,
} from "../../../contracts/agent-runtime.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import {
  HOME_SUGGESTIONS_REFRESH_THRESHOLD,
  spawnHomeSuggestionsRefresh,
} from "../../../kernel/agent-runtime/home-suggestions-refresh.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";

const logger = createRuntimeLogger("stella-runtime.home-suggestions-refresh");

/**
 * Home-suggestions refresh tick (stella-runtime).
 *
 * Increments a per-conversation counter every time a General-agent
 * finalize for that conversation lands; once the counter crosses
 * `HOME_SUGGESTIONS_REFRESH_THRESHOLD` the hook spawns a cheap
 * background refresh that updates the home-screen idea/suggestion
 * surface. Pre-migration this lived inline inside
 * `finalizeSubagentSuccess`.
 *
 * Resolves a sibling LLM route (`AGENT_IDS.HOME_SUGGESTIONS`) so the
 * refresh runs on a cheap reasoning model instead of whatever the
 * General agent used for its turn. Falls back to the General agent's
 * route if the resolver isn't wired or throws.
 *
 * Service deps:
 *   - `store` (factory-time, closure).
 *   - `payload.services.appendLocalChatEvent`,
 *     `payload.services.listLocalChatEvents` (per-turn — both
 *     required, the renderer notify path needs both halves).
 *   - `payload.services.resolvedLlm` (per-turn — fallback when the
 *     subsidiary resolver doesn't fire).
 *   - `payload.services.resolveSubsidiaryLlmRoute` (per-turn — picks
 *     the home-suggestions agent's route).
 */
export const createHomeSuggestionsRefreshHook = (opts: {
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (
      !agentHasCapability(payload.agentType, "triggersHomeSuggestionsRefresh")
    ) {
      return;
    }
    const services = payload.services;
    if (!services) return;
    if (
      !services.appendLocalChatEvent ||
      !services.listLocalChatEvents ||
      !services.resolvedLlm
    ) {
      return;
    }
    if (!payload.conversationId) return;

    try {
      const finalizes = opts.store
        .incrementGeneralFinalizesSinceHomeSuggestionsRefresh(
          payload.conversationId,
        );
      if (finalizes < HOME_SUGGESTIONS_REFRESH_THRESHOLD) return;

      let resolvedLlm = services.resolvedLlm;
      if (services.resolveSubsidiaryLlmRoute) {
        try {
          resolvedLlm = services.resolveSubsidiaryLlmRoute(
            AGENT_IDS.HOME_SUGGESTIONS,
          );
        } catch (error) {
          logger.debug("home-suggestions-refresh.route-fallback", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      spawnHomeSuggestionsRefresh({
        conversationId: payload.conversationId,
        resolvedLlm,
        store: opts.store,
        appendLocalChatEvent: services.appendLocalChatEvent,
        listLocalChatEvents: services.listLocalChatEvents,
      });
    } catch (error) {
      logger.debug("home-suggestions-refresh.tick-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  },
});
