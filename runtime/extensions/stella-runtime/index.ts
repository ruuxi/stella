import path from "node:path";
import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type {
  ExtensionFactory,
  HookDefinition,
} from "../../kernel/extensions/types.js";
import { createConnectorAvailabilityReminderHook } from "./hooks/connector-availability-reminder.hook.js";
import { createConnectorFormatReminderHook } from "./hooks/connector-format-reminder.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createRestartContinuationReminderHooks } from "./hooks/restart-continuation-reminder.hook.js";
import { createRevertNoticeHook } from "./hooks/revert-notice.hook.js";
import { createSelfModHooks } from "./hooks/self-mod.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";
import { createThreadSummariesRecordHook } from "./hooks/thread-summaries-record.hook.js";
import { resolveRuntimeSourceAsset } from "../../kernel/shared/runtime-paths.js";

const bundledAgentMetadataDir = () =>
  resolveRuntimeSourceAsset(
    "runtime",
    "extensions",
    "stella-runtime",
    "agent-metadata",
  );

/**
 * Keep shipped capability metadata authoritative without overwriting a user's
 * customized prompt body under `~/.stella/agents/`.
 */
export const loadStellaRuntimeAgents = (
  stellaDataDir: string,
  agentMetadataDir: string | URL = bundledAgentMetadataDir(),
) => {
  const metadataById = new Map(
    loadParsedAgentsFromDir(agentMetadataDir).map((agent) => [agent.id, agent]),
  );
  return loadParsedAgentsFromDir(path.join(stellaDataDir, "agents")).map(
    (homeAgent) => {
      const metadata = metadataById.get(homeAgent.id);
      if (!metadata) return homeAgent;
      return {
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        systemPrompt: homeAgent.systemPrompt,
        agentTypes: metadata.agentTypes,
        ...(metadata.toolsAllowlist
          ? { toolsAllowlist: metadata.toolsAllowlist }
          : {}),
        ...(metadata.model ? { model: metadata.model } : {}),
        ...(typeof metadata.maxAgentDepth === "number"
          ? { maxAgentDepth: metadata.maxAgentDepth }
          : {}),
      };
    },
  );
};

/**
 * Stella's runtime extension.
 *
 * Bundles every Stella-specific runtime behavior that used to live as
 * hardcoded calls inside the kernel:
 *
 *   - Agent registration from backend-synchronized home markdown
 *   - Self-mod baseline + detect-applied
 *   - Stale-user reminder
 *   - Dynamic memory reminder
 *   - Memory review spawn (post-orchestrator finalize)
 *   - Dream scheduler notify (post-subagent finalize)
 *   - Thread-summaries record (post-subagent finalize, capability-gated)
 *
 * Lives in `runtime/extensions/stella-runtime/` so power users can fork
 * any of these behaviors in place. The kernel has no special "bundled"
 * tier anymore — this extension goes through the same loader path as
 * any third-party extension, with `services` (stellaDataDir, stellaAppDir,
 * selfModMonitor, store) supplied by the runtime at registration time.
 */
const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {
  // Prompt bodies remain live and user-editable under `~/.stella/agents/`.
  // Shipped capability metadata comes from this runtime extension so a body
  // customization cannot freeze an older tool allowlist across updates.
  for (const agent of loadStellaRuntimeAgents(services.stellaDataDir)) {
    pi.registerAgent(agent);
  }

  // Orchestrator + subagent lifecycle hooks. Each `create…Hook` returns
  // a HookDefinition closing over whatever subset of services it
  // needs; we register them via a single helper to keep the factory
  // body flat.
  const register = <E extends Parameters<typeof pi.on>[0]>(
    hook: HookDefinition<E>,
  ): void => {
    pi.on(hook.event, hook.handler, hook.filter);
  };

  for (const hook of createSelfModHooks({
    stellaAppDir: services.stellaAppDir,
    selfModMonitor: services.selfModMonitor,
  })) {
    register(hook);
  }

  register(createStaleUserReminderHook());
  register(createDynamicMemoryReminderHook());
  // Connector-format reminder: one hidden `<system_reminder>` on the
  // single turn where the user's routing surface changes (desktop ⇄
  // connector / connector ⇄ different connector). Cheap — the
  // transition decision is precomputed in `prepareOrchestratorRun`.
  register(createConnectorFormatReminderHook());
  // Connector-availability reminder: deterministic keyword match of each
  // user message against the connector catalog; injects a hidden
  // connected/not-connected note for the orchestrator, deduped once per
  // active context window (compaction resets eligibility; declines win).
  register(
    createConnectorAvailabilityReminderHook({
      stellaDataDir: services.stellaDataDir,
      store: services.store,
      getStellaSiteAuth: services.getStellaSiteAuth,
    }),
  );
  // Revert-notice: one hidden `<system_reminder>` per pending self-mod
  // revert, drained on the next user turn for the affected conversation.
  // Runs alongside the other before_user_message reminders since it
  // costs nothing when no reverts are pending.
  register(createRevertNoticeHook({ store: services.store }));
  // Restart-continuation reminder: after a restart/quit that interrupted
  // agent work, the first user message in the affected conversation gets a
  // hidden note with the restart reason and each interrupted thread's
  // CURRENT state. Delivery-safe one-shot: the paired agent_end hook only
  // consumes it when the carrying turn succeeds (failed turns re-attach).
  // No-op on clean boots.
  for (const hook of createRestartContinuationReminderHooks({
    stellaDataDir: services.stellaDataDir,
    store: services.store,
  })) {
    register(hook);
  }
  register(
    createMemoryReviewHook({
      stellaDataDir: services.stellaDataDir,
      stellaAppDir: services.stellaAppDir,
      store: services.store,
    }),
  );
  register(
    createDreamSchedulerNotifyHook({
      stellaDataDir: services.stellaDataDir,
      store: services.store,
    }),
  );
  register(createThreadSummariesRecordHook({ store: services.store }));
};

export default stellaRuntimeExtension;
