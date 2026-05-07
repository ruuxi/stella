import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type { ExtensionFactory } from "../../kernel/extensions/types.js";
import { createDynamicMemoryReminderHook } from "./hooks/dynamic-memory-reminder.hook.js";
import { createPersonalityHook } from "./hooks/personality.hook.js";
import { createSelfModHooks } from "./hooks/self-mod.hook.js";
import { createStaleUserReminderHook } from "./hooks/stale-user-reminder.hook.js";

const AGENTS_DIR = new URL("./agents/", import.meta.url);

/**
 * Stella's runtime extension.
 *
 * Bundles every Stella-specific runtime behavior that used to live as
 * hardcoded calls inside the kernel:
 *
 *   - Agent prompt registration (markdown agents under `./agents/`)
 *   - Personality injection (orchestrator system-prompt hook)
 *   - Self-mod baseline + detect-applied (orchestrator lifecycle hooks)
 *   - Stale-user reminder (orchestrator user-message hook)
 *   - Dynamic memory reminder (orchestrator user-message hook)
 *
 *   …with more migrations to follow (memory injection cadence,
 *   post-finalize side effects).
 *
 * Lives in `runtime/extensions/stella-runtime/` so power users can fork
 * any of these behaviors in place. The kernel has no special "bundled"
 * tier anymore — this extension goes through the same loader path as
 * any third-party extension, with `services` (stellaHome, stellaRoot,
 * selfModMonitor) supplied by the runtime at registration time.
 */
const stellaRuntimeExtension: ExtensionFactory = (pi, services) => {
  for (const agent of loadParsedAgentsFromDir(AGENTS_DIR)) {
    pi.registerAgent(agent);
  }

  const personality = createPersonalityHook({
    stellaHome: services.stellaHome,
  });
  pi.on(personality.event, personality.handler, personality.filter);

  for (const hook of createSelfModHooks({
    stellaRoot: services.stellaRoot,
    selfModMonitor: services.selfModMonitor,
  })) {
    pi.on(hook.event, hook.handler, hook.filter);
  }

  const staleUserReminder = createStaleUserReminderHook();
  pi.on(
    staleUserReminder.event,
    staleUserReminder.handler,
    staleUserReminder.filter,
  );

  const dynamicMemoryReminder = createDynamicMemoryReminderHook();
  pi.on(
    dynamicMemoryReminder.event,
    dynamicMemoryReminder.handler,
    dynamicMemoryReminder.filter,
  );
};

export default stellaRuntimeExtension;
