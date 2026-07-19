/**
 * Dream Protocol scheduler.
 *
 * Dream consolidation is driven by orchestrator context growth, not by
 * per-event pings:
 *   - `token_interval`  — the orchestrator thread has grown ~`tokenInterval`
 *                         tokens since the last run (default 20k). Keeps
 *                         durable memory reasonably fresh during normal use.
 *   - `pre_compaction`  — the orchestrator thread is about to compact; flush a
 *                         consolidation so anything accumulated since the last
 *                         interval is folded before the middle is summarized.
 *   - `startup_catchup` — app just started; drain anything left over from a
 *                         previous session that ended before consolidating.
 *   - `manual`          — user clicked "Run Dream now".
 *
 * Eligibility: there must be unprocessed Dream-inbox rows (thread summaries,
 * memory notes, chronicle digests). `token_interval` additionally requires the
 * ~`tokenInterval` growth; `pre_compaction`, `startup_catchup`, and `manual`
 * run whenever anything is pending. Dream reads the durable inbox (not the
 * live transcript), so its cadence is independent of compaction — the
 * orchestrator already holds recent context in-window, so nothing needs to be
 * forced into durable memory until it grows past the interval or is about to
 * compact.
 *
 * Input staging (migration step 6): with `dream.inputSource: "inbox"` (the
 * default) the pass consumes Dream-inbox rows exactly as before, and the
 * orchestrator-delta derivation runs in SHADOW after each completed pass —
 * proposals land only in `memories/memory_shadow.md`, next to a record of
 * what the live pass changed, so the two input paths can be diffed before
 * cutover. With `dream.inputSource: "delta"` the orchestrator-thread delta
 * since a persisted message-ts watermark becomes the primary input; the
 * inbox list then serves only Chronicle transport rows, while the recording
 * hooks stay on so setting the config back to `inbox` is a full rollback.
 *
 * Single-flight: only one Dream run may execute at a time, via a mkdir lock
 * under `.stella/locks/dream/`.
 *
 * Fire-and-forget: callers `void maybeSpawnDreamRun(...)` and never await it.
 * The one deliberate exception is {@link awaitPreCompactionConsolidation} —
 * the consolidate-before-compact ordering — which awaits the current run with
 * a hard timeout and never lets Dream block or fail a compaction.
 */

import fs from "node:fs";
import path from "node:path";

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../../ai/types.js";
import {
  ensureDreamMemoryLayout,
  MEMORY_MAP_FILE,
  MEMORY_MAP_MAX_CHARS,
  MEMORY_MAP_MAX_ENTRIES,
  MEMORY_MAP_STALE_DAYS,
  memoriesRoot,
  memoryFilePath,
  memoryMapPath,
  memoryShadowPath,
} from "../memory/dream-storage.js";
import type { DreamInboxKind } from "../memory/dream-inbox-store.js";
import {
  appendToShadowLog,
  buildDreamDeltaTranscript,
  buildDreamDeltaUserMessage,
  buildDreamShadowSystemPrompt,
  buildDreamShadowUserPrompt,
  DREAM_DELTA_LOAD_LIMIT,
  formatDeltaEntry,
  formatShadowLogEntry,
  type DreamDeltaSourceMessage,
  type DreamDeltaTranscript,
} from "./dream-delta.js";
import { buildDurableMemoryReference } from "../thread-runtime.js";
import {
  getResolvedLlmApiKey,
  resolvedLlmSupportsCredentiallessCalls,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import { dreamTool } from "../tools/defs/dream.js";
import { readTool } from "../tools/defs/read.js";
import { strReplaceTool } from "../tools/defs/str-replace.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import { readHomePrompt } from "../prompts/home-prompts.js";

const logger = createRuntimeLogger("agent-runtime.dream-scheduler");

const DEFAULT_TOKEN_INTERVAL = 20_000;
const MAX_ITERATIONS = 12;

/**
 * Where Dream's consolidation input comes from (migration step 6):
 *   - `inbox` (default) — the durable Dream-inbox rows, exactly as before.
 *     While this is the live path, the orchestrator-delta derivation runs in
 *     SHADOW alongside it (unless `dream.deltaShadow: false`), writing its
 *     proposals to `memories/memory_shadow.md` for comparison.
 *   - `delta` — the cutover: the orchestrator-thread delta since the
 *     persisted watermark becomes the pass's primary input; the Dream list
 *     serves everything the delta does not cover. The recording hooks stay
 *     on, so rollback is simply setting the config back to `inbox`.
 *
 * Pre-flip drain gate: before flipping to `delta`, drain the inbox (run
 * Dream manually until `countUnprocessed()` is 0) so nothing recorded under
 * the old cadence straddles the transition. The flip is SAFE without the
 * drain — the applied-coverage gate keeps memory_note rows on the
 * model-driven path until an applied pass has covered the span below their
 * window, and thread_summary rows are only ever consumed once their report
 * provably persisted into the delta's thread — but draining first keeps the
 * first cutover window clean and the shadow-vs-live diff unambiguous.
 */
type DreamInputSource = "inbox" | "delta";

type DreamConfig = {
  enabled: boolean;
  tokenInterval: number;
  inputSource: DreamInputSource;
  deltaShadow: boolean;
};

type DreamRunOutcome = {
  /**
   * True when the pass ran to a clean final message (or the Claude Code
   * runtime finished without throwing). Iteration-capped, thrown, and
   * credential-less passes report false: rows they left unprocessed stay
   * queued, and the pass watermark must not advance past them.
   */
  completed: boolean;
};

type DreamRuntimeState = {
  inFlight: boolean;
  lastRunAt: number;
  /** Orchestrator token estimate captured at the last Dream run. */
  tokensAtLastRun: number;
  /** True once the persisted token baseline has been read for this process. */
  baselineHydrated: boolean;
  /**
   * Settles when the in-flight run finishes; never rejects. Lets the
   * consolidate-before-compact ordering join a run that is already running
   * instead of racing the single-flight lock.
   */
  completion: Promise<DreamRunOutcome> | null;
  /**
   * The completion handle a pre-compaction wait already timed out on. A
   * permanently hung pass must cost the full timeout at most once — later
   * boundaries seeing the same handle still in flight compact immediately.
   */
  timedOutCompletion: Promise<DreamRunOutcome> | null;
};

const RUNTIME_STATE = new Map<string, DreamRuntimeState>();

const stateFor = (stellaDataDir: string): DreamRuntimeState => {
  let state = RUNTIME_STATE.get(stellaDataDir);
  if (!state) {
    state = {
      inFlight: false,
      lastRunAt: 0,
      tokensAtLastRun: 0,
      baselineHydrated: false,
      completion: null,
      timedOutCompletion: null,
    };
    RUNTIME_STATE.set(stellaDataDir, state);
  }
  return state;
};

const lockDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "locks", "dream");

const fileMtimeMs = (filePath: string): number => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
};

const acquireLock = (stellaDataDir: string): (() => void) | null => {
  const dir = lockDir(stellaDataDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    return () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      logger.debug("dream.lock-error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    // Stale lock check: remove if older than 30 min.
    try {
      const stat = fs.statSync(dir);
      if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
        fs.rmSync(dir, { recursive: true, force: true });
        return acquireLock(stellaDataDir);
      }
    } catch {
      // ignore
    }
    return null;
  }
};

/**
 * Pending-inbox frontier, tolerant of partial store fakes and read failures:
 * 0 means "nothing pending / unknown", which always degrades to the safe
 * behavior (no watermark advance; pre-compaction ordering skips).
 */
const readPendingFrontierSafe = (store: RuntimeStore): number => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.pendingFrontier !== "function") return 0;
    const frontier = inbox.pendingFrontier();
    return Number.isFinite(frontier) && frontier > 0 ? frontier : 0;
  } catch {
    return 0;
  }
};

/**
 * Newest source_updated_at among rows the pass actually consumed since it
 * started. `null` = the store cannot answer (partial fakes / legacy), which
 * falls back to the historical all-pending-frontier advance; 0 = answerable
 * but nothing was consumed, which blocks the advance entirely.
 */
const readProcessedFrontierSafe = (
  store: RuntimeStore,
  sinceMs: number,
): number | null => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.maxProcessedSourceUpdatedAtSince !== "function") {
      return null;
    }
    const frontier = inbox.maxProcessedSourceUpdatedAtSince(sinceMs);
    return Number.isFinite(frontier) && frontier > 0 ? frontier : 0;
  } catch {
    return null;
  }
};

const readDeltaWatermarkSafe = (
  store: RuntimeStore,
  conversationId: string,
): number | null => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.readDeltaWatermark !== "function") return null;
    const ts = inbox.readDeltaWatermark(conversationId);
    return Number.isFinite(ts) && ts >= 0 ? ts : null;
  } catch {
    return null;
  }
};

const advanceDeltaWatermarkSafe = (
  store: RuntimeStore,
  conversationId: string,
  lastMessageTs: number,
): void => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.advanceDeltaWatermark === "function") {
      inbox.advanceDeltaWatermark(conversationId, lastMessageTs);
    }
  } catch (error) {
    logger.debug("dream.delta-watermark-write-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Applied (cutover-pass) coverage frontier; `null` when the store cannot
 * answer, which conservatively reads as "no applied coverage" — memory_note
 * consumption then stays on the model path.
 */
const readAppliedThroughTsSafe = (
  store: RuntimeStore,
  conversationId: string,
): number | null => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.readAppliedThroughTs !== "function") return null;
    const ts = inbox.readAppliedThroughTs(conversationId);
    return Number.isFinite(ts) && ts >= 0 ? ts : null;
  } catch {
    return null;
  }
};

const advanceAppliedThroughTsSafe = (
  store: RuntimeStore,
  conversationId: string,
  throughTs: number,
): void => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.advanceAppliedThroughTs === "function") {
      inbox.advanceAppliedThroughTs(conversationId, throughTs);
    }
  } catch (error) {
    logger.debug("dream.applied-watermark-write-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const readTokenBaselineSafe = (store: RuntimeStore): number | null => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.readTokenBaseline !== "function") return null;
    return inbox.readTokenBaseline();
  } catch {
    return null;
  }
};

const writeTokenBaselineSafe = (store: RuntimeStore, tokens: number): void => {
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.writeTokenBaseline === "function") {
      inbox.writeTokenBaseline(tokens);
    }
  } catch {
    // scheduling bookkeeping only
  }
};

/**
 * Raw persisted orchestrator messages (compaction overlays never applied),
 * newest `limit` of them; empty when the store cannot serve them (partial
 * fakes), which degrades to inbox-only behavior everywhere.
 */
const loadRawOrchestratorMessagesSafe = (
  store: RuntimeStore,
  conversationId: string,
  limit: number,
): DreamDeltaSourceMessage[] => {
  try {
    if (typeof store.loadRawThreadMessagesWithEntryTypes !== "function") {
      return [];
    }
    return store.loadRawThreadMessagesWithEntryTypes(conversationId, limit);
  } catch {
    return [];
  }
};

const readDreamConfig = (stellaDataDir: string): DreamConfig => {
  const configPath = path.join(stellaDataDir, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { dream?: Partial<DreamConfig> };
    const dream = parsed.dream ?? {};
    return {
      // Dream is on by default and consolidates the Dream inbox into the
      // durable on-disk memory layout. It is independent of Live Memory
      // (Chronicle screen capture); the only way it stays off is if the
      // user explicitly sets `dream.enabled: false` in `.stella/config.json`.
      enabled: dream.enabled !== false,
      tokenInterval:
        typeof dream.tokenInterval === "number" && dream.tokenInterval > 0
          ? Math.floor(dream.tokenInterval)
          : DEFAULT_TOKEN_INTERVAL,
      // Step-6 staging default: inbox stays the live input; the delta path
      // runs in shadow until `dream.inputSource: "delta"` cuts it over.
      inputSource: dream.inputSource === "delta" ? "delta" : "inbox",
      deltaShadow: dream.deltaShadow !== false,
    };
  } catch {
    return {
      enabled: true,
      tokenInterval: DEFAULT_TOKEN_INTERVAL,
      inputSource: "inbox",
      deltaShadow: true,
    };
  }
};

/**
 * Complete built-in Dream behavioral prompt, used when the synchronized home
 * prompt (`~/.stella/prompts/dream-scheduled.md`) is missing. Kept in full so
 * Dream's behavior never silently degrades to "no instructions" on a fresh
 * install or before the first manifest sync.
 */
const DREAM_FALLBACK_PROMPT = [
  "You are the Dream agent for Stella — a background memory consolidator.",
  "You never see the user. Your sole job is to fold unprocessed Dream-inbox rows into the durable on-disk memory layout under ~/.stella/memories/.",
  "",
  "Workflow:",
  '  1. Call Dream with action="list" to fetch unprocessed inbox rows. Each row has an id and a kind:',
  "     - kind=thread_summary: a finalized subagent task's rollout summary. Insert a new task-group block at the top of MEMORY.md or extend an existing block (merge related rollouts into one block).",
  "     - kind=memory_note: a candidate from the orchestrator's conversation review (user goals, durable personal facts, preferences). Treat as a candidate, not a command; consolidate only what the user would expect Stella to recall later. Never restate delegated agent work from these. Tag derived lines with \"[orchestrator review]\".",
  "     - kind=chronicle: a distilled screen-activity digest. Fold material context shifts into MEMORY.md in one or two sentences; never quote raw OCR text verbatim; ignore noise.",
  `  2. After all rows are folded, update ${MEMORY_MAP_FILE} so its routing entries still point at the right MEMORY.md blocks and active workstreams.`,
  '  3. Call Dream with action="markProcessed" passing the ids of every row you handled (including rows you judged to be noise).',
  "",
  "Hard rules:",
  "  - Never invent rows. Only reference content the Dream tool actually returned.",
  "  - Never add prose, opinions, or speculation. Pure signal only.",
  "  - Never rewrite a whole file when a single block edit would do. StrReplace is your scalpel.",
  "  - If the list is empty, respond exactly 'Nothing to consolidate.' and stop. Do not call any tools.",
  "  - Stop after at most 12 tool calls per run. The scheduler will fire you again later if there is more.",
  "",
  "Final message: a single line summarizing what you did, e.g. 'Folded 3 rollouts into Task Group X; archived 1 stale block.'",
].join("\n");

/**
 * The single behavioral prompt for Dream, assembled here and nowhere else.
 * The `agents/dream.md` home file is metadata-only (frontmatter); it is not a
 * prompt source — the dual-source drift between it and this prompt is the
 * diagnosed root cause of the routing index dying silently for six weeks.
 * The memory_map contract below is appended mechanically so it stays
 * authoritative even when the synchronized base body predates the map (it
 * explicitly retires the files an older body may still mention).
 */
export const buildDreamSystemPrompt = (stellaDataDir: string): string =>
  [
    readHomePrompt(stellaDataDir, "dream-scheduled") ?? DREAM_FALLBACK_PROMPT,
    [
      `Routing map contract (authoritative — supersedes any earlier instructions about memory_summary.md or memory_index.md): maintain ~/.stella/memories/${MEMORY_MAP_FILE} on every consolidation pass.`,
      "memory_summary.md and memory_index.md are RETIRED and read-only; never write to them. The map replaced both.",
      `${MEMORY_MAP_FILE} is pointer-only routing — what memory contains and where to find it: task families with aliases the user actually says, repo names, paths, prior-decision hooks, and the best retrieval source (a MEMORY.md block by date and title, profile.md, threads:<thread_id>, or transcripts). No narrative and no restated facts; durable facts belong in MEMORY.md blocks.`,
      `Stage durable constraints that are not yet in profile.md under its "## Derived constraints" section, one line each tagged [derived YYYY-MM-DD]; remove a line once the user promotes it via Remember. profile.md remains exclusively Remember-owned; never edit it.`,
      `Hard budget, enforced mechanically: at most ${MEMORY_MAP_MAX_ENTRIES} entries and ${MEMORY_MAP_MAX_CHARS} injected characters (HTML comments are not counted). A write that would exceed the budget IS REJECTED with an error — respond by curating: merge related entries, prune entries older than ${MEMORY_MAP_STALE_DAYS} days unless recently useful, tighten wording. Never work around the cap by deleting the DREAM anchor comments.`,
      "Give every entry an updated YYYY-MM-DD date. Edit only between the DREAM:MAP_START / DREAM:MAP_END and DREAM:DERIVED_START / DREAM:DERIVED_END anchors using StrReplace.",
      `If the file still contains a "Migrated focus notes" staging section, curate it away: convert each line into a routing entry or drop it (its facts are already in MEMORY.md), then delete the section including its anchors.`,
      "Never put secrets, credentials, tokens, private keys, auth headers, or sensitive personal data in the map; store only the minimum routing metadata.",
    ].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

const buildDreamTools = (): Tool[] =>
  [dreamTool, readTool, strReplaceTool].map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters as Tool["parameters"],
  }));

const toToolResultMessage = (
  toolCall: ToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  isError,
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

/**
 * Kinds whose rows the orchestrator delta can represent byte-equivalently
 * (design review Q3) — but only for the delta's OWN conversation, and for
 * `memory_note` only once applied coverage is contiguous through the
 * window start (a note's source span reaches below its own timestamp; a
 * span covered only by shadow passes had its proposals discarded). The
 * cutover pass hides exactly its covered slice from the Dream list (no
 * double-feeding) and consumes it mechanically after a clean pass; rows
 * reported by other conversations, legacy NULL-conversation rows, and
 * anything outside the applied-contiguous window keep flowing through the
 * model-driven list/markProcessed path unchanged.
 */
const DELTA_COVERED_KINDS: readonly DreamInboxKind[] = [
  "thread_summary",
  "memory_note",
];
const DELTA_COVERED_KINDS_NOTES_UNSAFE: readonly DreamInboxKind[] = [
  "thread_summary",
];

type DeltaInput = {
  conversationId: string;
  delta: DreamDeltaTranscript;
  /** Watermark this pass derives from — the window's exclusive lower bound. */
  sinceWatermark: number;
  /**
   * The load limit filled the window AND its oldest loaded message is
   * already past the watermark: an unloaded backlog span may sit between
   * the watermark and the window. Derivation proceeds on what was loaded
   * and the watermark still advances over the unseen raw span (accepted
   * loss for non-row content, warn-logged — raw messages remain reachable
   * through transcript FTS), but mechanical consumption is skipped — a row
   * whose report lives in the unseen span must stay on the model path.
   */
  truncatedBelow: boolean;
  /**
   * Kinds this pass may hide from the list and consume mechanically.
   * `memory_note` is included only when applied coverage was contiguous
   * through `sinceWatermark` — otherwise (first post-flip window, flip-back
   * gaps, stores that cannot answer) notes stay on the model-driven path.
   */
  coveredKinds: readonly DreamInboxKind[];
};

/**
 * Detect a window that the load limit cut off BELOW: the projection returns
 * the NEWEST `limit` messages, so a full window whose oldest message is
 * newer than the watermark implies messages between the two were never
 * loaded — coverage will jump the unseen span.
 */
const isWindowTruncatedBelow = (
  messages: DreamDeltaSourceMessage[],
  loadLimit: number,
  watermark: number,
): boolean =>
  messages.length >= loadLimit &&
  typeof messages[0]?.timestamp === "number" &&
  messages[0].timestamp > watermark;

/**
 * Prepare the cutover pass's primary input. Returns null — meaning "run the
 * legacy inbox pass" — when the delta path is not active, the store cannot
 * serve raw messages, the watermark needs bootstrapping, or the delta has no
 * material content. Bootstrap (watermark 0) advances straight to the newest
 * relevant message WITHOUT deriving: the pre-cutover history was already
 * consolidated by the inbox path, and the one-time deep pass is migration
 * step 9, not this one.
 */
const prepareDeltaInput = (args: {
  store: RuntimeStore;
  conversationId?: string;
  config: DreamConfig;
}): DeltaInput | null => {
  if (args.config.inputSource !== "delta" || !args.conversationId) return null;
  const conversationId = args.conversationId;
  const watermark = readDeltaWatermarkSafe(args.store, conversationId);
  if (watermark === null) return null;
  const messages = loadRawOrchestratorMessagesSafe(
    args.store,
    conversationId,
    DREAM_DELTA_LOAD_LIMIT,
  );
  if (messages.length === 0) return null;
  if (watermark === 0) {
    const bootstrap = buildDreamDeltaTranscript(messages, 0);
    if (bootstrap.newestMessageTs > 0) {
      advanceDeltaWatermarkSafe(
        args.store,
        conversationId,
        bootstrap.newestMessageTs,
      );
      logger.info("dream.delta.bootstrapped", {
        conversationId,
        watermark: bootstrap.newestMessageTs,
      });
    }
    return null;
  }
  const delta = buildDreamDeltaTranscript(messages, watermark);
  if (!delta.transcript) return null;
  if (delta.truncated && delta.coveredThroughTs <= watermark) {
    // Same-millisecond tie group bigger than the whole budget: the tie
    // rollback pins coverage at the watermark, so the pass re-derives this
    // window every time (lossless, but a permanent stall worth seeing).
    logger.warn("dream.delta.coverage-pinned", {
      conversationId,
      watermark,
      includedMessages: delta.includedMessages,
    });
  }
  const truncatedBelow = isWindowTruncatedBelow(
    messages,
    DREAM_DELTA_LOAD_LIMIT,
    watermark,
  );
  if (truncatedBelow) {
    logger.warn("dream.delta.window-truncated-below", {
      conversationId,
      watermark,
      oldestLoadedTs: messages[0]?.timestamp ?? 0,
    });
  }
  // Applied-contiguity gate for memory_note rows (shadow→cutover
  // transition): notes are covered kinds only when every span below this
  // window was covered by an APPLIED pass. Shadow passes advance the shared
  // watermark but not applied coverage, so the first post-flip window (and
  // any flip-back gap) automatically routes notes to the model path until
  // applied coverage catches up.
  const appliedThroughTs = readAppliedThroughTsSafe(args.store, conversationId);
  const notesApplied = appliedThroughTs !== null && appliedThroughTs >= watermark;
  if (!notesApplied) {
    logger.info("dream.delta.notes-on-model-path", {
      conversationId,
      watermark,
      appliedThroughTs: appliedThroughTs ?? -1,
    });
  }
  return {
    conversationId,
    delta,
    sinceWatermark: watermark,
    truncatedBelow,
    coveredKinds: notesApplied
      ? DELTA_COVERED_KINDS
      : DELTA_COVERED_KINDS_NOTES_UNSAFE,
  };
};

/**
 * Post-pass bookkeeping for a CLEANLY completed delta-input pass: advance the
 * delta watermark through what the pass actually read, and mechanically
 * consume ONLY the inbox rows this delta provably covers — same reporting
 * conversation, source time strictly inside THIS pass's window
 * (sinceWatermark, coveredThroughTs]. Everything else stays queued for the
 * model-driven list path: other conversations' rows, legacy NULL rows,
 * pre-window rows (their span may only ever have been shadow-covered —
 * proposals discarded by design), and the whole window when the load limit
 * truncated it below (an unseen backlog span may hold the report). That is
 * what keeps at-least-once intact while the recording hooks remain on as
 * the rollback path.
 */
const finishDeltaPass = (store: RuntimeStore, input: DeltaInput): void => {
  advanceDeltaWatermarkSafe(
    store,
    input.conversationId,
    input.delta.coveredThroughTs,
  );
  if (input.truncatedBelow) {
    // No consumption AND no applied-coverage advance over a window whose
    // oldest span was never loaded: a memory_note sourced in the unseen
    // span must not become mechanically consumable through a frontier that
    // papered over it. The next full window advances applied coverage past
    // this one (the unseen RAW span stays accepted-loss, warn-logged at
    // detection), so the note gate reopens one pass later at most.
    logger.warn("dream.delta.consumption-skipped-truncated-window", {
      conversationId: input.conversationId,
    });
    return;
  }
  // This pass's derivation was APPLIED (its output landed in MEMORY.md /
  // the map), so applied coverage advances — the gate that lets THIS and
  // later passes consume memory_note rows once coverage below their
  // windows is contiguous.
  advanceAppliedThroughTsSafe(
    store,
    input.conversationId,
    input.delta.coveredThroughTs,
  );
  try {
    const inbox = store.dreamInboxStore;
    if (typeof inbox.markKindsProcessedThrough === "function") {
      const { updated } = inbox.markKindsProcessedThrough({
        conversationId: input.conversationId,
        kinds: input.coveredKinds,
        sinceTs: input.sinceWatermark,
        throughTs: input.delta.coveredThroughTs,
      });
      if (updated > 0) {
        logger.debug("dream.delta.covered-rows-marked", { updated });
      }
    }
  } catch (error) {
    logger.debug("dream.delta.covered-rows-mark-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const runDream = async (args: {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  config: DreamConfig;
  conversationId?: string;
}): Promise<DreamRunOutcome> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: args.stellaDataDir,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : await getResolvedLlmApiKey(args.resolvedLlm);
  if (
    !useClaudeCode &&
    !apiKey &&
    !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)
  ) {
    logger.debug("dream.skipped.no-api-key");
    return { completed: false };
  }

  await ensureDreamMemoryLayout(args.stellaDataDir);

  const deltaInput = prepareDeltaInput(args);
  const dreamDispatchConfig = {
    stellaDataDir: args.stellaDataDir,
    ...(deltaInput
      ? {
          inboxListExclude: {
            conversationId: deltaInput.conversationId,
            // Mirrors what finishDeltaPass may consume: when the applied
            // gate keeps memory_note rows on the model path, they stay
            // VISIBLE in the list too — hidden-but-unconsumed would strand
            // them for a pass.
            kinds: deltaInput.coveredKinds,
            sinceTs: deltaInput.sinceWatermark,
          },
        }
      : {}),
  };
  const tools = buildDreamTools();
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: deltaInput
            ? buildDreamDeltaUserMessage(deltaInput.delta.transcript)
            : 'Run the Dream consolidation pass. Start by calling Dream with action="list".',
        },
      ],
      timestamp: Date.now(),
    },
  ];
  let totalToolCalls = 0;

  if (useClaudeCode) {
    try {
      const finalText = await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaDataDir,
        agentType: AGENT_IDS.DREAM,
        stellaModel: args.resolvedLlm.model.id,
        context: {
          systemPrompt: buildDreamSystemPrompt(args.stellaDataDir),
          messages,
          tools,
        },
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          totalToolCalls += 1;
          const dispatch = await dispatchLocalTool(toolName, toolArgs, {
            conversationId: "dream",
            store: {
              dreamInboxStore: args.store.dreamInboxStore,
            },
            dream: dreamDispatchConfig,
          });
          if (!dispatch.handled) {
            return {
              error: JSON.stringify({
                success: false,
                error: `Tool ${toolName} not available to the Dream agent.`,
              }),
            };
          }
          return { result: dispatch.text };
        },
      });
      logger.debug("dream.completed", {
        iterations: 1,
        toolCalls: totalToolCalls,
        finalText: finalText.slice(0, 80),
      });
      if (deltaInput) finishDeltaPass(args.store, deltaInput);
      return { completed: true };
    } catch (error) {
      logger.debug("dream.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { completed: false };
    }
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const context: Context = {
      systemPrompt: buildDreamSystemPrompt(args.stellaDataDir),
      messages,
      tools,
    };

    let response: AssistantMessage;
    try {
      response = await completeSimple(
        args.resolvedLlm.model,
        context,
        apiKey ? { apiKey } : undefined,
      );
    } catch (error) {
      logger.debug("dream.completeSimple.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { completed: false };
    }

    messages.push(response);

    const toolCalls = response.content.filter(
      (part): part is ToolCall => part.type === "toolCall",
    );

    if (toolCalls.length === 0) {
      logger.debug("dream.completed", {
        iterations: iteration + 1,
        toolCalls: totalToolCalls,
        finalText: readAssistantText(response).slice(0, 80),
      });
      if (deltaInput) finishDeltaPass(args.store, deltaInput);
      return { completed: true };
    }

    for (const toolCall of toolCalls) {
      totalToolCalls += 1;
      try {
        const dispatch = await dispatchLocalTool(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>,
          {
            conversationId: "dream",
            store: {
              dreamInboxStore: args.store.dreamInboxStore,
            },
            dream: dreamDispatchConfig,
          },
        );
        if (!dispatch.handled) {
          messages.push(
            toToolResultMessage(
              toolCall,
              JSON.stringify({
                success: false,
                error: `Tool ${toolCall.name} not available to the Dream agent.`,
              }),
              true,
            ),
          );
          continue;
        }
        messages.push(toToolResultMessage(toolCall, dispatch.text, false));
      } catch (error) {
        messages.push(
          toToolResultMessage(
            toolCall,
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            true,
          ),
        );
      }
    }
  }

  logger.debug("dream.iteration-cap", {
    iterations: MAX_ITERATIONS,
    toolCalls: totalToolCalls,
  });
  // Partial pass: some rows may have been folded and marked processed, but
  // the queue was not drained — the watermark must not advance past it.
  return { completed: false };
};

export type SpawnDreamTrigger =
  | "token_interval"
  | "pre_compaction"
  | "startup_catchup"
  | "manual";

export type SpawnDreamArgs = {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  trigger: SpawnDreamTrigger;
  /**
   * Orchestrator thread token estimate for this finalize. Required for
   * `token_interval` gating (growth since the last run); ignored by other
   * triggers, which run whenever anything is pending.
   */
  orchestratorTokenEstimate?: number;
  /**
   * Orchestrator conversation (= its thread key) driving this trigger.
   * Enables the step-6 delta machinery: the shadow derivation after an inbox
   * pass, and the delta input itself once `dream.inputSource: "delta"`.
   * Absent for `manual`/`startup_catchup` runner triggers, which then behave
   * exactly as before the migration.
   */
  conversationId?: string;
};

export type SpawnDreamResultReason =
  | "scheduled"
  | "disabled"
  | "in_flight"
  | "count_failed"
  | "no_inputs"
  | "below_threshold"
  | "lock_busy"
  | "no_api_key"
  | "unavailable";

export type SpawnDreamResult = {
  scheduled: boolean;
  reason: SpawnDreamResultReason;
  pendingItems: number;
  detail?: string;
};

/**
 * Whether the cutover delta path has unconsolidated orchestrator material —
 * the delta-mode analog of `countUnprocessed() > 0`. Scans only the newest
 * few raw messages (an older-only backlog is caught by the next trigger — a
 * freshness lag, never loss). A zero watermark is bootstrapped here directly
 * (no LLM pass needed just to stamp coverage). Always false outside delta
 * mode or when the store cannot serve raw messages.
 */
const DELTA_ELIGIBILITY_SCAN_LIMIT = 25;

const hasDeltaWork = (
  store: RuntimeStore,
  conversationId: string | undefined,
  config: DreamConfig,
): boolean => {
  if (config.inputSource !== "delta" || !conversationId) return false;
  const watermark = readDeltaWatermarkSafe(store, conversationId);
  if (watermark === null) return false;
  const messages = loadRawOrchestratorMessagesSafe(
    store,
    conversationId,
    watermark === 0 ? DREAM_DELTA_LOAD_LIMIT : DELTA_ELIGIBILITY_SCAN_LIMIT,
  );
  if (messages.length === 0) return false;
  if (watermark === 0) {
    const bootstrap = buildDreamDeltaTranscript(messages, 0);
    if (bootstrap.newestMessageTs > 0) {
      advanceDeltaWatermarkSafe(store, conversationId, bootstrap.newestMessageTs);
      logger.info("dream.delta.bootstrapped", {
        conversationId,
        watermark: bootstrap.newestMessageTs,
      });
    }
    return false;
  }
  return messages.some(
    (msg) =>
      typeof msg.timestamp === "number" &&
      msg.timestamp > watermark &&
      formatDeltaEntry(msg) !== null,
  );
};

/**
 * Decide whether to fire a Dream run, then fire it asynchronously. Never
 * throws; never blocks the caller.
 */
export const maybeSpawnDreamRun = async (
  args: SpawnDreamArgs,
): Promise<SpawnDreamResult> => {
  const config = readDreamConfig(args.stellaDataDir);
  if (!config.enabled && args.trigger !== "manual") {
    return {
      scheduled: false,
      reason: "disabled",
      pendingItems: 0,
    };
  }

  const state = stateFor(args.stellaDataDir);
  if (state.inFlight) {
    return {
      scheduled: false,
      reason: "in_flight",
      pendingItems: 0,
    };
  }

  let pendingItems = 0;
  try {
    pendingItems = args.store.dreamInboxStore.countUnprocessed();
  } catch (error) {
    logger.debug("dream.count-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      scheduled: false,
      reason: "count_failed",
      pendingItems: 0,
    };
  }

  if (pendingItems === 0 && !hasDeltaWork(args.store, args.conversationId, config)) {
    return {
      scheduled: false,
      reason: "no_inputs",
      pendingItems,
    };
  }

  // `token_interval` is the only gated trigger; `pre_compaction`,
  // `startup_catchup`, and `manual` run whenever there is pending material.
  // The interval baseline follows compaction down: if the estimate dropped
  // below the last baseline (a compaction shrank the thread), reset the
  // baseline so growth is measured from the new floor rather than never
  // re-arming. The baseline is persisted (dream_scheduler_state) and
  // hydrated once per process, so a worker restart no longer resets it to 0
  // and fires a spurious full-growth pass.
  if (args.trigger === "token_interval") {
    if (!state.baselineHydrated) {
      state.baselineHydrated = true;
      const persisted = readTokenBaselineSafe(args.store);
      if (
        persisted !== null &&
        state.lastRunAt === 0 &&
        state.tokensAtLastRun === 0
      ) {
        state.tokensAtLastRun = persisted;
      }
    }
    const estimate = args.orchestratorTokenEstimate;
    if (typeof estimate === "number" && estimate < state.tokensAtLastRun) {
      state.tokensAtLastRun = estimate;
      writeTokenBaselineSafe(args.store, estimate);
    }
    const growth =
      typeof estimate === "number" ? estimate - state.tokensAtLastRun : 0;
    if (growth < config.tokenInterval) {
      return {
        scheduled: false,
        reason: "below_threshold",
        pendingItems,
      };
    }
  }

  const apiKey = await getResolvedLlmApiKey(args.resolvedLlm);
  if (!apiKey && !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)) {
    logger.debug("dream.skipped.no-api-key");
    return {
      scheduled: false,
      reason: "no_api_key",
      pendingItems,
    };
  }

  const release = acquireLock(args.stellaDataDir);
  if (!release) {
    logger.debug("dream.lock-busy");
    return {
      scheduled: false,
      reason: "lock_busy",
      pendingItems,
    };
  }
  state.inFlight = true;

  const memoryMtimeBefore = fileMtimeMs(memoryFilePath(args.stellaDataDir));
  const mapMtimeBefore = fileMtimeMs(memoryMapPath(args.stellaDataDir));
  // Pending frontier captured BEFORE the pass runs: a completed pass may
  // advance the watermark up to this point. Conservative by construction —
  // rows arriving mid-pass carry a later source_updated_at and stay ahead of
  // the watermark.
  const frontierAtStart = readPendingFrontierSafe(args.store);
  const passStartedAt = Date.now();
  const completion = runDream({
    stellaDataDir: args.stellaDataDir,
    store: args.store,
    resolvedLlm: args.resolvedLlm,
    config,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  })
    .catch((error): DreamRunOutcome => {
      logger.debug("dream.run-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { completed: false };
    })
    .then((outcome) => {
      if (outcome.completed && frontierAtStart > 0) {
        // Advance to what the pass actually consumed, never past it: a
        // >LIST-limit backlog used to advance the watermark to the full
        // pending frontier even though the pass never listed the newest
        // rows. A store that cannot answer keeps the historical behavior; a
        // pass that consumed nothing does not advance at all — either way
        // the cost ceiling is one redundant best-effort pre-compaction
        // pass, never skipped material.
        const processedFrontier = readProcessedFrontierSafe(
          args.store,
          passStartedAt,
        );
        const advanceTo =
          processedFrontier === null
            ? frontierAtStart
            : Math.min(frontierAtStart, processedFrontier);
        if (advanceTo > 0) {
          try {
            args.store.dreamInboxStore.writeConsolidationWatermark({
              frontier: advanceTo,
            });
          } catch (error) {
            logger.debug("dream.watermark-write-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (outcome.completed) {
        // Inbox GC rides Dream's own cadence: single-flighted, and only
        // after a pass that just proved the queue machinery healthy.
        // Consumed rows past retention are at-rest duplicates of window /
        // transcript / MEMORY.md content (4.4MB measured live).
        try {
          const inbox = args.store.dreamInboxStore;
          if (typeof inbox.gcProcessedRows === "function") {
            const { deleted } = inbox.gcProcessedRows();
            if (deleted > 0) {
              logger.info("dream.inbox-gc", { deleted });
            }
          }
        } catch (error) {
          logger.debug("dream.inbox-gc-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return outcome;
    })
    .finally(() => {
      state.inFlight = false;
      // `state.completion` is deliberately left pointing at the (now
      // settled) promise: a pre-compaction caller that raced the run's
      // completion still awaits it and reads the real outcome instead of
      // finding a null handle.
      state.lastRunAt = Date.now();
      if (typeof args.orchestratorTokenEstimate === "number") {
        state.tokensAtLastRun = args.orchestratorTokenEstimate;
        writeTokenBaselineSafe(args.store, args.orchestratorTokenEstimate);
      }
      // Staleness alarm for the routing layer: a pass that grew the ledger
      // without touching the map is exactly how the old index died silently.
      // One warn per occurrence keeps it observable without failing the run.
      const memoryChanged =
        fileMtimeMs(memoryFilePath(args.stellaDataDir)) !== memoryMtimeBefore;
      const mapChanged =
        fileMtimeMs(memoryMapPath(args.stellaDataDir)) !== mapMtimeBefore;
      if (memoryChanged && !mapChanged) {
        logger.warn("dream.memory-map.stale", {
          detail: `Dream updated MEMORY.md without updating ${MEMORY_MAP_FILE}`,
        });
      }
      release();
    });
  state.completion = completion;
  state.timedOutCompletion = null;
  void completion;

  // Shadow validation (migration step 6): after the live inbox pass has
  // fully finished (lock released — the chain above includes the finally),
  // derive what the orchestrator-delta input path WOULD have consolidated
  // and record it to memory_shadow.md next to what the live pass actually
  // changed. Deliberately OUTSIDE `state.completion`: a pre-compaction
  // boundary that joins the run must never wait on the shadow's LLM call.
  if (
    config.inputSource === "inbox" &&
    config.deltaShadow &&
    args.conversationId
  ) {
    const shadowConversationId = args.conversationId;
    void completion
      .then((outcome) => {
        if (!outcome.completed) return;
        return runDreamDeltaShadow({
          stellaDataDir: args.stellaDataDir,
          store: args.store,
          resolvedLlm: args.resolvedLlm,
          conversationId: shadowConversationId,
          liveMemoryChanged:
            fileMtimeMs(memoryFilePath(args.stellaDataDir)) !==
            memoryMtimeBefore,
          liveMapChanged:
            fileMtimeMs(memoryMapPath(args.stellaDataDir)) !== mapMtimeBefore,
        });
      })
      .catch((error) => {
        logger.debug("dream.delta-shadow.spawn-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return {
    scheduled: true,
    reason: "scheduled",
    pendingItems,
  };
};

export type DreamShadowOutcome =
  /** Proposal derived, logged to memory_shadow.md, watermark advanced. */
  | "completed"
  /** First run for this conversation: watermark stamped, nothing derived. */
  | "bootstrapped"
  /** No delta-relevant messages past the watermark; nothing to derive. */
  | "skipped_empty"
  /** A shadow derivation is already in flight for this data dir. */
  | "skipped_busy"
  /** Store cannot serve raw messages / delta watermark (partial fakes). */
  | "skipped_unsupported"
  /** The LLM call outlived the timeout; abandoned, watermark untouched. */
  | "timed_out"
  /** Credentials missing, LLM call failed, or the log write failed. */
  | "failed";

/**
 * Hard ceiling on the shadow's one-shot LLM call. Nothing waits on the
 * shadow, but the single-flight guard does: without a bound, one hung
 * provider stream would hold SHADOW_IN_FLIGHT for the process lifetime and
 * silently end the validation window (every later shadow: skipped_busy).
 * A timed-out call is abandoned — its eventual result is discarded, the
 * watermark stays put, and the window is re-derived next pass.
 */
export const DREAM_SHADOW_TIMEOUT_MS = 180_000;

const SHADOW_IN_FLIGHT = new Set<string>();

/**
 * Shadow validation for the orchestrator-delta input (migration step 6).
 * Runs after a completed inbox-driven pass: builds the delta since the
 * persisted watermark, derives a consolidation PROPOSAL with a one-shot
 * no-tool completion, and appends it — alongside what the live pass actually
 * changed — to `memories/memory_shadow.md` for diffing. On a clean pass the
 * delta watermark advances, so coverage carries over seamlessly when
 * `dream.inputSource: "delta"` cuts the input over.
 *
 * Never touches MEMORY.md, the map, the inbox, or any injected/resident
 * surface — the shadow file is absent from every read path, so the prompt
 * prefix stays byte-identical regardless of what the shadow writes. Failures
 * leave the watermark alone; the window is re-derived next pass.
 */
export const runDreamDeltaShadow = async (args: {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  conversationId: string;
  liveMemoryChanged: boolean;
  liveMapChanged: boolean;
  timeoutMs?: number;
}): Promise<DreamShadowOutcome> => {
  if (SHADOW_IN_FLIGHT.has(args.stellaDataDir)) return "skipped_busy";
  SHADOW_IN_FLIGHT.add(args.stellaDataDir);
  try {
    const watermark = readDeltaWatermarkSafe(args.store, args.conversationId);
    if (watermark === null) return "skipped_unsupported";
    const messages = loadRawOrchestratorMessagesSafe(
      args.store,
      args.conversationId,
      DREAM_DELTA_LOAD_LIMIT,
    );
    if (messages.length === 0) return "skipped_unsupported";
    if (watermark === 0) {
      const bootstrap = buildDreamDeltaTranscript(messages, 0);
      if (bootstrap.newestMessageTs > 0) {
        advanceDeltaWatermarkSafe(
          args.store,
          args.conversationId,
          bootstrap.newestMessageTs,
        );
      }
      logger.info("dream.delta-shadow.bootstrapped", {
        conversationId: args.conversationId,
        watermark: bootstrap.newestMessageTs,
      });
      return "bootstrapped";
    }

    const delta = buildDreamDeltaTranscript(messages, watermark);
    if (!delta.transcript) return "skipped_empty";
    // Degraded-window visibility (shadow never consumes rows, so these are
    // observability-only here): a load-limit-truncated window derives with
    // its oldest span missing, and a coverage pin means a same-ms tie group
    // outgrew the budget and this window will re-derive every pass.
    if (
      isWindowTruncatedBelow(messages, DREAM_DELTA_LOAD_LIMIT, watermark)
    ) {
      logger.warn("dream.delta-shadow.window-truncated-below", {
        conversationId: args.conversationId,
        watermark,
        oldestLoadedTs: messages[0]?.timestamp ?? 0,
      });
    }
    if (delta.truncated && delta.coveredThroughTs <= watermark) {
      logger.warn("dream.delta-shadow.coverage-pinned", {
        conversationId: args.conversationId,
        watermark,
      });
    }

    const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
      stellaAppDir: args.stellaDataDir,
      modelId: args.resolvedLlm.model.id,
    });
    const apiKey = useClaudeCode
      ? undefined
      : await getResolvedLlmApiKey(args.resolvedLlm);
    if (
      !useClaudeCode &&
      !apiKey &&
      !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)
    ) {
      logger.debug("dream.delta-shadow.no-api-key");
      return "failed";
    }

    const systemPrompt = buildDreamShadowSystemPrompt();
    // Same unified ALREADY-KNOWN reference (profile + map) the compaction
    // summarizer uses, so the shadow validates the real dedup context.
    const alreadyKnown = buildDurableMemoryReference(args.stellaDataDir);
    const shadowMessages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildDreamShadowUserPrompt({
              transcript: delta.transcript,
              sinceIso: new Date(watermark).toISOString(),
              ...(alreadyKnown ? { alreadyKnown } : {}),
            }),
          },
        ],
        timestamp: Date.now(),
      },
    ];

    let proposal = "";
    try {
      const derive = async (): Promise<string> => {
        if (useClaudeCode) {
          return await runClaudeCodeAgentTextCompletion({
            stellaAppDir: args.stellaDataDir,
            agentType: AGENT_IDS.DREAM,
            stellaModel: args.resolvedLlm.model.id,
            context: { systemPrompt, messages: shadowMessages, tools: [] },
          });
        }
        const response = await completeSimple(
          args.resolvedLlm.model,
          { systemPrompt, messages: shadowMessages, tools: [] },
          apiKey ? { apiKey } : undefined,
        );
        return readAssistantText(response);
      };
      const derivation = derive();
      // Post-abandon safety: once the race times out nothing awaits this
      // promise anymore, so observe a late rejection here to keep it from
      // surfacing as an unhandled rejection. Pre-timeout rejections still
      // propagate through the race to the catch below.
      derivation.catch(() => {});
      const raced = await raceWithTimeout(
        derivation,
        Math.max(1, args.timeoutMs ?? DREAM_SHADOW_TIMEOUT_MS),
      );
      if (raced === "timed_out") {
        logger.warn("dream.delta-shadow.timed-out", {
          conversationId: args.conversationId,
        });
        return "timed_out";
      }
      proposal = raced;
    } catch (error) {
      logger.debug("dream.delta-shadow.completion-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
    if (!proposal.trim()) {
      logger.debug("dream.delta-shadow.empty-proposal");
      return "failed";
    }

    const entry = formatShadowLogEntry({
      nowIso: new Date().toISOString(),
      conversationId: args.conversationId,
      sinceTs: watermark,
      coveredThroughTs: delta.coveredThroughTs,
      includedMessages: delta.includedMessages,
      transcriptChars: delta.transcript.length,
      truncated: delta.truncated,
      liveMemoryChanged: args.liveMemoryChanged,
      liveMapChanged: args.liveMapChanged,
      proposal,
    });
    try {
      const shadowPath = memoryShadowPath(args.stellaDataDir);
      fs.mkdirSync(memoriesRoot(args.stellaDataDir), { recursive: true });
      let existing: string | null = null;
      try {
        existing = fs.readFileSync(shadowPath, "utf-8");
      } catch {
        existing = null;
      }
      // Write-temp-then-rename so a reader (or a crash) never sees a torn
      // file. Two processes sharing a data dir can still lose one entry to
      // the read-modify-write race — accepted: the log is diagnostic only
      // and the watermark advance below is monotonic either way.
      const tmpPath = `${shadowPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmpPath, appendToShadowLog(existing, entry), "utf-8");
      fs.renameSync(tmpPath, shadowPath);
    } catch (error) {
      // Without the recorded proposal there is nothing to diff, so the
      // window is deliberately left uncovered for a retry next pass.
      logger.debug("dream.delta-shadow.log-write-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }

    advanceDeltaWatermarkSafe(
      args.store,
      args.conversationId,
      delta.coveredThroughTs,
    );
    logger.info("dream.delta-shadow.completed", {
      conversationId: args.conversationId,
      deltaMessages: delta.includedMessages,
      deltaChars: delta.transcript.length,
      truncated: delta.truncated,
      proposalChars: proposal.length,
      liveMemoryChanged: args.liveMemoryChanged,
      liveMapChanged: args.liveMapChanged,
      watermarkFrom: watermark,
      watermarkTo: delta.coveredThroughTs,
    });
    return "completed";
  } catch (error) {
    logger.debug("dream.delta-shadow.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  } finally {
    SHADOW_IN_FLIGHT.delete(args.stellaDataDir);
  }
};

/**
 * Hard ceiling on how long compaction may wait for a Dream pass. Compaction
 * runs on the background scheduler (never the user-visible finalize path),
 * so a few minutes of waiting costs nothing visible — but the wait must be
 * bounded because a hung provider stream would otherwise stall compaction
 * while the window keeps growing toward the hard context limit.
 */
export const DREAM_PRE_COMPACTION_TIMEOUT_MS = 180_000;

export type PreCompactionConsolidationOutcome =
  /** A Dream pass ran (or was joined) and finished cleanly within budget. */
  | "consolidated"
  /** A pass ran but failed or hit its iteration cap; material stays queued. */
  | "incomplete"
  /** The timeout elapsed first; the pass keeps running in the background. */
  | "timed_out"
  /** Nothing pending, or a completed pass already covers the frontier. */
  | "skipped_fresh"
  /** No pass could start (disabled, lock busy, no credentials, …). */
  | "not_started"
  /** Unexpected error inside the ordering itself. */
  | "failed";

export type PreCompactionConsolidationResult = {
  outcome: PreCompactionConsolidationOutcome;
  pendingItems: number;
  waitedMs: number;
  detail?: string;
};

const raceWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | "timed_out"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Consolidate-before-compact ordering (design review §6.2c / migration #5).
 *
 * Called by the compaction path when the trigger is met, BEFORE the middle is
 * folded: gives Dream one bounded, best-effort window to extract durable
 * memories from the span that is about to be summarized, so those facts exit
 * the checkpoint recursion via MEMORY.md instead of surviving only through
 * repeated summarization.
 *
 * Contract — ordering affects freshness only, never correctness:
 *   - NEVER throws and never blocks beyond `timeoutMs`; every outcome means
 *     "compact now". A timed-out pass keeps running in the background
 *     (single-flight lock held); its writes land on disk and enter the
 *     window at a later compaction boundary.
 *   - Skip-if-fresh via the persisted watermark: when the last completed
 *     pass already started at/after the newest pending inbox row, waiting
 *     cannot improve checkpoint freshness, so compaction proceeds
 *     immediately. (A >LIST-limit backlog can advance the watermark past
 *     rows the pass never listed; those rows stay queued for the next
 *     trigger — freshness lag, never loss.)
 *   - No double-processing: consumption is governed solely by per-row
 *     `processed_by_dream_at`; the watermark is scheduling bookkeeping.
 *   - Joins an already-running pass instead of racing the single-flight
 *     lock; otherwise spawns one through the normal gates.
 *   - Touches only disk files and the inbox — never thread entries — so the
 *     injected prompt prefix stays byte-identical until the compaction
 *     boundary refresh reads the (possibly fresher) disk state.
 */
export const awaitPreCompactionConsolidation = async (args: {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  timeoutMs?: number;
  /** Orchestrator conversation; enables the delta-input eligibility check. */
  conversationId?: string;
}): Promise<PreCompactionConsolidationResult> => {
  const startedAt = Date.now();
  const finish = (
    outcome: PreCompactionConsolidationOutcome,
    pendingItems: number,
    detail?: string,
  ): PreCompactionConsolidationResult => {
    const result: PreCompactionConsolidationResult = {
      outcome,
      pendingItems,
      waitedMs: Date.now() - startedAt,
      ...(detail ? { detail } : {}),
    };
    logger.info("dream.pre-compaction", result);
    return result;
  };

  try {
    let pendingItems = 0;
    try {
      pendingItems = args.store.dreamInboxStore.countUnprocessed();
    } catch {
      pendingItems = 0;
    }
    // In delta mode, unconsolidated orchestrator material is pending work
    // even with a drained inbox, and the inbox frontier/watermark freshness
    // check below does not describe it — the delta watermark advance inside
    // the pass is what guarantees skip-if-fresh equivalent behavior there.
    const config = readDreamConfig(args.stellaDataDir);
    const deltaWork = hasDeltaWork(args.store, args.conversationId, config);
    const frontier = readPendingFrontierSafe(args.store);
    if ((pendingItems === 0 || frontier === 0) && !deltaWork) {
      return finish("skipped_fresh", pendingItems, "nothing pending");
    }
    let watermark: { frontier: number } | null = null;
    try {
      const inbox = args.store.dreamInboxStore;
      watermark =
        typeof inbox.readConsolidationWatermark === "function"
          ? inbox.readConsolidationWatermark()
          : null;
    } catch {
      watermark = null;
    }
    if (!deltaWork && watermark && watermark.frontier >= frontier) {
      return finish(
        "skipped_fresh",
        pendingItems,
        "a completed pass already covers the pending frontier",
      );
    }

    const state = stateFor(args.stellaDataDir);
    // A pass a previous boundary already timed out on must not tax every
    // subsequent boundary the full timeout: if that same run is still in
    // flight, compact immediately. Its writes (if it ever finishes) land on
    // disk and enter the window at a later boundary refresh.
    if (
      state.inFlight &&
      state.completion !== null &&
      state.completion === state.timedOutCompletion
    ) {
      return finish(
        "not_started",
        pendingItems,
        "prior boundary wait on this pass already timed out",
      );
    }
    // `state.completion` outlives a settled run (see the spawn path), so a
    // stale handle from a long-finished pass must not be mistaken for a live
    // one: only join when a run is actually in flight, and after spawning
    // only trust the handle when it changed from the pre-spawn snapshot (or
    // the spawn definitively reported `scheduled`).
    const completionBeforeSpawn = state.completion;
    let completion = state.inFlight ? state.completion : null;
    let joined = completion !== null;
    if (!completion) {
      const spawn = await maybeSpawnDreamRun({
        stellaDataDir: args.stellaDataDir,
        store: args.store,
        resolvedLlm: args.resolvedLlm,
        trigger: "pre_compaction",
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      });
      if (spawn.scheduled) {
        completion = state.completion;
        if (!completion) {
          return finish("not_started", pendingItems, "no completion handle");
        }
      } else if (
        state.completion &&
        state.completion !== completionBeforeSpawn
      ) {
        // `in_flight` raced: another caller registered a run between our
        // check and the spawn. Join it.
        completion = state.completion;
        joined = true;
      } else {
        return finish("not_started", pendingItems, spawn.reason);
      }
    }

    const timeoutMs = Math.max(
      1,
      args.timeoutMs ?? DREAM_PRE_COMPACTION_TIMEOUT_MS,
    );
    const raced = await raceWithTimeout(completion, timeoutMs);
    if (raced === "timed_out") {
      // Remember the handle so later boundaries skip this hung pass instead
      // of each paying the full timeout again.
      state.timedOutCompletion = completion;
      return finish(
        "timed_out",
        pendingItems,
        joined ? "joined run still in flight" : "spawned run still in flight",
      );
    }
    return raced.completed
      ? finish("consolidated", pendingItems)
      : finish("incomplete", pendingItems);
  } catch (error) {
    return finish(
      "failed",
      0,
      error instanceof Error ? error.message : String(error),
    );
  }
};
