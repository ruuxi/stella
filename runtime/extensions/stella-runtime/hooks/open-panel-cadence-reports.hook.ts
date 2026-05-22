import {
  AGENT_IDS,
  agentHasCapability,
} from "../../../contracts/agent-runtime.js";
import {
  spawnOpenPanelCadenceReports,
} from "../../../kernel/agent-runtime/open-panel-cadence-reports.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";

const logger = createRuntimeLogger("stella-runtime.open-panel-cadence-reports");

export const createOpenPanelCadenceReportsHook = (opts: {
  stellaRoot: string;
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
    if (!services?.resolvedLlm) return;

    try {
      let resolvedLlm = services.resolvedLlm;
      if (services.resolveSubsidiaryLlmRoute) {
        try {
          resolvedLlm = services.resolveSubsidiaryLlmRoute(
            AGENT_IDS.OPEN_PANEL_REPORTS,
          );
        } catch (error) {
          logger.debug("open-panel-reports.route-fallback", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      spawnOpenPanelCadenceReports({
        stellaRoot: opts.stellaRoot,
        resolvedLlm,
        store: opts.store,
      });
    } catch (error) {
      logger.debug("open-panel-reports.tick-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
