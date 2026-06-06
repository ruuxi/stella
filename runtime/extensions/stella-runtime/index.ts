import path from "node:path";
import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type {
  ExtensionFactory,
  HookDefinition,
} from "../../kernel/extensions/types.js";
import { createConnectorFormatReminderHook } from "./hooks/connector-format-reminder.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createOpenPanelCadenceReportsHook } from "./hooks/open-panel-cadence-reports.hook.js";
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
 *   - Agent prompt registration (markdown agents under `./agents/`)
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
 * any third-party extension, with `services` (stellaHome, stellaRoot,
 * selfModMonitor, store) supplied by the runtime at registration time.
 */
const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {
  // Agent prompts are reconciled into `${stellaHome}/agents/` on startup
  // (see `agents-sync.ts`), so the live, user-editable copies load from there.
  // The bundled defaults in `agents.ts` remain the merge base, so the runtime
  // still has every agent even before the first reconcile.
  for (const agent of loadParsedAgentsFromDir(
    path.join(services.stellaHome, "agents"),
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
    stellaRoot: services.stellaRoot,
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
  // Revert-notice: one hidden `<system_reminder>` per pending self-mod
  // revert, drained on the next user turn for the affected conversation.
  // Runs alongside the other before_user_message reminders since it
  // costs nothing when no reverts are pending.
  register(createRevertNoticeHook({ store: services.store }));
  register(
    createMemoryReviewHook({
      stellaHome: services.stellaHome,
      stellaRoot: services.stellaRoot,
      store: services.store,
    }),
  );
  register(
    createDreamSchedulerNotifyHook({
      stellaHome: services.stellaHome,
      store: services.store,
    }),
  );
  register(
    createOpenPanelCadenceReportsHook({
      stellaHome: services.stellaHome,
      store: services.store,
    }),
  );
  register(createThreadSummariesRecordHook({ store: services.store }));
};

export default stellaRuntimeExtension;
