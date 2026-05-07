import type { SelfModMonitor } from "../agent-runtime/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type { LocalContextEvent } from "../local-history.js";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";

/**
 * Runtime services exposed to extension factories.
 *
 * Stella-runtime hooks (personality, self-mod, …) need access to
 * stable per-runtime values — `stellaHome`, `stellaRoot`,
 * `selfModMonitor`, and the SQLite store — that can't be reconstructed
 * from per-emit hook payloads alone. The loader threads this object
 * into every `ExtensionFactory` invocation so factories can close over
 * the services they need at registration time. Hot-reload replays the
 * same services object — the runtime owns its lifetime, factories
 * never have to worry about staleness.
 *
 * Lives in its own module to avoid an import cycle: `extensions/types.ts`
 * cannot import from `agent-runtime/types.ts` (the agent runtime imports
 * extension types), but extension factories legitimately need
 * `SelfModMonitor`, `RuntimeStore`, and friends from the runtime side.
 * Splitting the services type out keeps the import graph cycle-free.
 */
export type ExtensionServices = {
  /** Mutable user-data root (today the same as `stellaRoot`; will diverge if user data moves to ~/.stella). */
  stellaHome: string;
  /** Repo root for self-mod git operations. */
  stellaRoot: string;
  /** Self-mod monitor — null in headless test runtimes. */
  selfModMonitor: SelfModMonitor | null;
  /** Runtime SQLite store. Hooks that need to read/write per-conversation counters or thread summaries reach in here. */
  store: RuntimeStore;
  /** Shared memory store, exposed directly so hooks don't have to reach through RuntimeStore internals. */
  memoryStore: MemoryStore;
};

/**
 * Per-emit runtime services attached to lifecycle hook payloads.
 *
 * Some hook events (notably `agent_end`) need values that vary per
 * RUN — `resolvedLlm` is per-turn, `appendLocalChatEvent` /
 * `listLocalChatEvents` come from per-`RuntimeRunOptions` callbacks
 * passed in by the desktop layer, and `messagesSnapshot` only has
 * meaning at the moment the run finalizes. The runtime populates this
 * object at emit time from the live run options; hooks read whichever
 * accessors they need. Every field is optional so hooks must guard
 * before using them and emit sites are free to omit fields they don't
 * have wired (e.g. test runs without a renderer-side `appendLocalChatEvent`).
 */
export type RuntimeRunServices = {
  /** Resolved LLM route the run used. Per-turn — finalize hooks reuse it for their follow-up calls (memory review, etc.). */
  resolvedLlm?: ResolvedLlmRoute;
  /** Snapshot of the agent's in-memory message history at finalize time. */
  messagesSnapshot?: AgentMessage[];
  /**
   * Append a local-chat event for this conversation. Routes through the
   * worker server wrapper that fires `localChat:updated`, so renderer
   * subscribers re-fetch reactively.
   */
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;
  /** Read recent local-chat events. */
  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
  /**
   * Resolve the LLM route for a sibling agent type so post-run
   * background passes can run on a different model than the agent
   * that just finalized.
   */
  resolveSubsidiaryLlmRoute?: (agentType: string) => ResolvedLlmRoute;
  /**
   * Memory-review user-turn counter AFTER incrementing for this run,
   * forwarded from `prepareOrchestratorRun`. Undefined for non-user
   * turns and for agents that don't declare `triggersMemoryReview`.
   * The memory-review hook reads this to decide whether to fire on
   * this finalize.
   */
  userTurnsSinceMemoryReview?: number;
};
