import path from "node:path";
import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type {
  ExtensionFactory,
  HookDefinition,
} from "../../kernel/extensions/types.js";
import { createConnectorAvailabilityReminderHook } from "./hooks/connector-availability-reminder.hook.js";
import { createConnectorFormatReminderHook } from "./hooks/connector-format-reminder.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createRevertNoticeHook } from "./hooks/revert-notice.hook.js";
import { createSelfModHooks } from "./hooks/self-mod.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";
import { createThreadSummariesRecordHook } from "./hooks/thread-summaries-record.hook.js";

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
  // Runtime bootstrap until the paired backend prompt manifest publishes the
  // manager. A synchronized home copy registers afterwards and replaces it.
  const managerBootstrap = loadParsedAgentsFromDir(
    new URL("./agent-metadata/", import.meta.url),
  ).find((agent) => agent.id === AGENT_IDS.MANAGER);
  if (managerBootstrap) {
    pi.registerAgent(managerBootstrap);
  }
  // Backend prompts are reconciled into `${stellaDataDir}/agents/` on startup,
  // with local capability metadata attached by prompt-manifest-sync.ts. The
  // live, user-editable copies load from there.
  for (const agent of loadParsedAgentsFromDir(
    path.join(services.stellaDataDir, "agents"),
  )) {
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
    }),
  );
  // Revert-notice: one hidden `<system_reminder>` per pending self-mod
  // revert, drained on the next user turn for the affected conversation.
  // Runs alongside the other before_user_message reminders since it
  // costs nothing when no reverts are pending.
  register(createRevertNoticeHook({ store: services.store }));
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
