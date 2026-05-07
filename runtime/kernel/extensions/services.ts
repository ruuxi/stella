import type { SelfModMonitor } from "../agent-runtime/types.js";

/**
 * Runtime services exposed to extension factories.
 *
 * Stella-runtime hooks (personality, self-mod, …) need access to mutable
 * per-user paths and runtime monitors that can't be reconstructed from
 * the per-emit hook payload alone. The loader threads this object into
 * every `ExtensionFactory` invocation so factories can close over the
 * services they need at registration time. Hot-reload replays the same
 * services object — the runtime owns its lifetime, factories never have
 * to worry about staleness.
 *
 * Lives in its own module to avoid an import cycle: `extensions/types.ts`
 * cannot import from `agent-runtime/types.ts` (the agent runtime imports
 * extension types), but extension factories legitimately need
 * `SelfModMonitor` from the runtime side. Splitting the services type
 * out keeps the cycle-free.
 */
export type ExtensionServices = {
  /** Mutable user-data root (today the same as `stellaRoot`; will diverge if user data moves to ~/.stella). */
  stellaHome: string;
  /** Repo root for self-mod git operations. */
  stellaRoot: string;
  /** Self-mod monitor — null in headless test runtimes. */
  selfModMonitor: SelfModMonitor | null;
};
