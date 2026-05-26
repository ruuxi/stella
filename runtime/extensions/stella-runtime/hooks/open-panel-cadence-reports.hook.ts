import {
  AGENT_IDS,
  agentHasCapability,
} from "../../../contracts/agent-runtime.js";
import {
  spawnOpenPanelCadenceReports,
} from "../../../kernel/agent-runtime/open-panel-cadence-reports.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import {
  getDefaultModel,
  getModelOverride,
} from "../../../kernel/preferences/local-preferences.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";

const logger = createRuntimeLogger("stella-runtime.open-panel-cadence-reports");

// When the user has not explicitly picked a model for the report agent,
// ride the orchestrator's pick. Reports are a background helper; honoring
// the user's main assistant choice (incl. BYOK) beats falling through to
// the Stella default for a feature they may have moved off Stella entirely.
const hasExplicitPreference = (
  stellaRoot: string,
  agentType: string,
): boolean =>
  Boolean(
    getModelOverride(stellaRoot, agentType) ??
      getDefaultModel(stellaRoot, agentType),
  );

export const createOpenPanelCadenceReportsHook = (opts: {
  stellaHome: string;
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "recordsThreadSummary")) {
      return;
    }
    const services = payload.services;
    if (!services?.resolvedLlm) return;

    try {
      let resolvedLlm = services.resolvedLlm;
      if (services.resolveSubsidiaryLlmRoute) {
        const preferredAgent = hasExplicitPreference(
          opts.stellaHome,
          AGENT_IDS.OPEN_PANEL_REPORTS,
        )
          ? AGENT_IDS.OPEN_PANEL_REPORTS
          : AGENT_IDS.ORCHESTRATOR;
        try {
          resolvedLlm = services.resolveSubsidiaryLlmRoute(preferredAgent);
        } catch (error) {
          logger.debug("open-panel-reports.route-fallback", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!payload.conversationId || !services.appendLocalChatEvent) return;

      spawnOpenPanelCadenceReports({
        conversationId: payload.conversationId,
        stellaRoot: opts.stellaHome,
        resolvedLlm,
        store: opts.store,
        appendLocalChatEvent: services.appendLocalChatEvent,
      });
    } catch (error) {
      logger.debug("open-panel-reports.tick-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
