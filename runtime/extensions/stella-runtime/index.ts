import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type {
  ExtensionFactory,
  HookDefinition,
} from "../../kernel/extensions/types.js";
import { createChronicleInjectionHook } from "./hooks/chronicle-injection.hook.js";
import { createDreamSchedulerNotifyHook } from "./hooks/dream-scheduler-notify.hook.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createHomeSuggestionsRefreshHook } from "./hooks/home-suggestions-refresh.hook.js";
import { createMemoryInjectionHook } from "./hooks/memory-injection.hook.js";
import { createMemoryReviewHook } from "./hooks/memory-review.hook.js";
import { createPersonalityHook } from "./hooks/personality.hook.js";
import { createSelfModHooks } from "./hooks/self-mod.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";
import { createThreadSummariesRecordHook } from "./hooks/thread-summaries-record.hook.js";

const AGENTS_DIR = new URL("./agents/", import.meta.url);

/**
 * Stella's runtime extension.
 *
 * Bundles every Stella-specific runtime behavior that used to live as
 * hardcoded calls inside the kernel:
 *
 *   - Agent prompt registration (markdown agents under `./agents/`)
 *   - Personality injection
 *   - Self-mod baseline + detect-applied
 *   - Stale-user reminder
 *   - Dynamic memory reminder
 *   - Memory injection cadence + bundle assembly
 *   - Memory review spawn (post-orchestrator finalize)
 *   - Dream scheduler notify (post-subagent finalize)
 *   - Home-suggestions refresh tick (post-subagent finalize)
 *   - Thread-summaries record (post-subagent finalize, capability-gated)
 *
 * Lives in `runtime/extensions/stella-runtime/` so power users can fork
 * any of these behaviors in place. The kernel has no special "bundled"
 * tier anymore — this extension goes through the same loader path as
 * any third-party extension, with `services` (stellaHome, stellaRoot,
 * selfModMonitor, store) supplied by the runtime at registration time.
 */
const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {
  for (const agent of loadParsedAgentsFromDir(AGENTS_DIR)) {
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

  register(createPersonalityHook({ stellaHome: services.stellaHome }));

  for (const hook of createSelfModHooks({
    stellaRoot: services.stellaRoot,
    selfModMonitor: services.selfModMonitor,
  })) {
    register(hook);
  }

  register(createStaleUserReminderHook());
  register(createDynamicMemoryReminderHook());
  // Keep memory injection after reminder hooks: reminders prepend near the
  // top, while the memory bundle appends close to the user's message.
  register(
    createMemoryInjectionHook({
      stellaHome: services.stellaHome,
      stellaRoot: services.stellaRoot,
      store: services.store,
      memoryStore: services.memoryStore,
    }),
  );
  // Chronicle injection rides the same `before_user_message` cadence as
  // the memory bundle but gates on file mtime (not turn count) so fresh
  // chronicle summaries surface the moment the user returns after an
  // idle period, without re-injecting when nothing changed.
  register(
    createChronicleInjectionHook({
      stellaHome: services.stellaHome,
      stellaRoot: services.stellaRoot,
      store: services.store,
    }),
  );
  register(
    createMemoryReviewHook({
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
    createHomeSuggestionsRefreshHook({
      stellaRoot: services.stellaRoot,
      store: services.store,
    }),
  );
  register(createThreadSummariesRecordHook({ store: services.store }));
};

export default stellaRuntimeExtension;
