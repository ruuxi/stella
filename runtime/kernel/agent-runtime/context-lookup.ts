import path from "node:path";

import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
} from "../../ai/types.js";
import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { parseJsonWithRepair } from "../../ai/utils/json-parse.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { HostAppBrowserContextSnapshot } from "../../protocol/index.js";
import type { LocalContextEvent } from "../local-history.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import {
  sanitizePromptContext,
  sanitizeToolVisibleText,
} from "../tools/safety.js";
import type {
  RecallIndexThreadRow,
  RuntimeStore,
} from "../storage/runtime-store.js";
import { tokenizeSearchQuery } from "../storage/runtime-store.js";
import { formatDateTimeReminder } from "../message-timestamp.js";
import {
  deriveRuntimeThreadLiveState,
  formatRuntimeThreadStatusSuffix,
  runtimeThreadLastActiveAt,
} from "../runtime-threads.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";

const MAX_CONTEXT_OUTPUT_TOKENS = 900;
const EAGER_MEMORY_FILE_CHAR_BUDGET = 4_000;
const MAX_RECALL_STEPS = 4;
// Sized so a full unified-search observation (12 ranked results, the top
// several message hits carrying their surrounding-exchange lines) survives
// untruncated; at 6k the exchange blocks pushed the tail results off.
const RECALL_OBSERVATION_CHAR_BUDGET = 20_000;
const MAX_MEMORY_SEARCH_TERMS = 12;
const MAX_MEMORY_SEARCH_TERM_CHARS = 120;
const MAX_MEMORY_SEARCH_MATCHES = 40;
const MAX_MEMORY_SEARCH_CONTEXT_LINES = 1;
const MAX_MEMORY_SEARCH_RESULTS_CHARS = 16_000;
const CHRONICLE_DIR_SEGMENTS = ["memories_extensions", "chronicle"] as const;

type ContextLookupStore = Pick<
  RuntimeStore,
  | "listThreadsForRecallIndex"
  | "countThreadsCreatedSince"
  | "listAgentProgressSummaries"
>;

/**
 * Thread lookup is an LLM read over an inline index, not a query: the seed
 * carries the most recent N threads and the model identifies candidates
 * directly, so recall no longer depends on how a status question is phrased.
 * N covers ~a month of realistic recall at heavy usage; a high-volume day
 * (heavy fan-out users) widens it.
 */
export const RECALL_INDEX_BASE_LIMIT = 500;
export const RECALL_INDEX_HIGH_VOLUME_LIMIT = 1_000;
const RECALL_INDEX_HIGH_VOLUME_DAILY_THREADS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Hard ceiling on the RENDERED index, enforced regardless of row limit —
 * the row caps only bound entry COUNT, and unbounded descriptions/excerpts
 * at 1000 rows could otherwise blow the seed. ~240k chars ≈ ~60k tokens.
 * When exceeded, the oldest-by-last-active entries drop first (they are the
 * least likely recall targets) and the index says how many were cut.
 */
export const RECALL_INDEX_CHAR_BUDGET = 240_000;
/** Per-entry cap on the description line; result/error are SQL-truncated. */
const RECALL_INDEX_DESCRIPTION_CHARS = 300;

/** Latest live progress phrases surfaced per ACTIVE thread. */
const MAX_LIVE_PROGRESS_SUMMARIES = 3;

const RECALL_PROMPT_INTRO =
  "You are Stella's recall agent. Resolve the lookup request into a concise, useful answer for the orchestrator, drawing on the user's durable memory, past agent work, past conversation transcripts, recent activity, and live app/browser state.";

const RECALL_SEARCH_MEMORY_DESCRIPTION =
  "keyword-search the durable memory ledger (MEMORY.md). 2-8 concrete terms.";
const RECALL_SEARCH_DESCRIPTION =
  "keyword-search past conversation transcripts (what the user and Stella actually said, across ALL conversations) plus agent work too old for the thread index. Returns matching [agent thread] entries first, then [message] hits in chronological order (oldest → newest) — read those as a timeline.";

const RECALL_PROMPT_SHARED_GUIDANCE = [
  "THREAD QUESTIONS ARE ANSWERED FROM THE INDEX, NOT BY SEARCHING. The context below carries a # Thread Index — the full record of Stella's recent delegated agent threads (name, description, last-active time, final-result excerpt, error) — and a # Live Thread Status tail listing the threads executing a turn RIGHT NOW with timestamped live-progress phrases. Any indexed thread absent from that tail is paused (idle but resumable); there is no 'dead' state. For any question about past work, a task, or a thread's status ('is X still running?', 'did it crash?', 'what did the Y agent do?'): scan the ENTIRE index for candidates — match on meaning, not exact wording — and OPEN YOUR BRIEF BY QUOTING the candidate thread_id(s) you matched, then answer from the entry, the live-status tail, and the current time (e.g. 'thread X is active; as of 3:04 PM it was searching documentation for rate limits'). Quote the error excerpt when a run errored. Do not guess at status, and do not conclude a thread doesn't exist until you have scanned the whole index.",
  "",
  "Reading search results by their type labels: `[agent thread]` results are past work/tasks — they carry a resumable thread_id, live status, and summary. `[message]` results are things actually said in chat — dated snippets with their conversation context; these are what answer episodic questions (\"did I ever mention X\", \"where did we go\") that never became a task or memory note. When memory search comes up empty on something the user plausibly said before, run search before answering \"nothing found\".",
  "",
  "Top [message] hits include a 'surrounding exchange' — the messages sent right before/after. Treat those exchanges as PRIMARY evidence and reconstruct what happened from them: a user asking where to go, getting an address, then sending en-route messages means they took that trip at that time, even though no message states it outright. Later retellings are NOT evidence of absence — especially Stella's own earlier \"I have no record of that\" replies, which may be the exact failure this lookup exists to fix; when primary messages imply the event, trust them over any later claim that nothing was recorded. For \"first/last time X happened\" questions: enumerate EVERY dated candidate event you can establish from the hits, then answer with the earliest/latest — never skip an older episode because a newer one is more vividly confirmed; include the enumeration in the brief so the orchestrator can see the timeline.",
  "",
  "Transcript search is keyword-based: generic words (\"first drive\") mostly find retellings, concrete nouns find the event. Status/filler words (\"active\", \"crashed\", \"latest\", \"progress\") match chatter, not the thing — build queries from concrete nouns: names, places, file paths, slugs, error text, and candidate terms you already have from the eager context or the lookup request.",
  "",
  "The context below already includes the thread index, the memory summary, a (possibly truncated) ledger, the current time, live app/browser state, recent activity, live thread status, and chronicle. Search only when the answer likely lives in the deeper ledger or in past conversations. Resolve in as few steps as possible — answer the moment you can.",
  "",
  "When past threads are relevant, include their thread_id(s) in the brief so the orchestrator can resume them. Keep the brief tight — only what helps answer or route the request.",
  'Answer with exactly "Nothing relevant found." ONLY when you have earned it: for thread/work questions, after scanning the entire # Thread Index; for episodic/message questions, after running search at least TWICE with DIFFERENT concrete terms (reformulate — drop status/filler words, use names, slugs, file paths, places). Never conclude nothing-found from a single noisy search.',
];

// Exported so replay/eval harnesses can drive the exact production prompt.
export const RECALL_SYSTEM_PROMPT = [
  RECALL_PROMPT_INTRO,
  "",
  "You work in up to a few steps. At each step respond with EXACTLY ONE JSON object and nothing else:",
  `  {"action":"search_memory","terms":["...", "..."]}  — ${RECALL_SEARCH_MEMORY_DESCRIPTION}`,
  `  {"action":"search","query":"..."}                   — ${RECALL_SEARCH_DESCRIPTION}`,
  '  {"action":"answer","brief":"..."}                   — finish with a concise markdown brief.',
  "",
  ...RECALL_PROMPT_SHARED_GUIDANCE,
].join("\n");

/**
 * The prompt for external-engine runs (Claude Code): that runtime's decision
 * contract DISCARDS any model reply that starts with `{` but is not a
 * `{"type":...}` payload, so the JSON-action dialect above can never
 * round-trip. There the search actions are hosted TOOLS instead (see
 * `RECALL_RUNTIME_TOOLS`) and the final brief is plain text.
 */
export const RECALL_TOOL_RUNTIME_SYSTEM_PROMPT = [
  RECALL_PROMPT_INTRO,
  "",
  "You work in up to a few steps using the hosted search tools:",
  `  search_memory — ${RECALL_SEARCH_MEMORY_DESCRIPTION}`,
  `  search — ${RECALL_SEARCH_DESCRIPTION}`,
  'These are Stella-hosted tools, NOT native function-call tools: a native call to them fails with "No such tool available". Invoke them ONLY via the structured decision JSON {"type":"tool_request","toolName":"search","args":{"query":"..."}}. A failed native call does NOT mean search is unavailable — reissue it as the structured decision. Never tell the orchestrator that search is unavailable.',
  "When you can answer, reply with the concise markdown brief itself as your final message — plain text, no JSON wrapper.",
  "",
  ...RECALL_PROMPT_SHARED_GUIDANCE,
].join("\n");

/**
 * The recall search actions as hosted tools, for engines whose runtime
 * carries a real tool protocol (Claude Code). Backed by the exact same
 * in-process search functions the JSON-action loop uses; `runRecall` wires
 * them in via `executeTool`.
 */
export const RECALL_RUNTIME_TOOLS: Tool[] = [
  {
    name: "search_memory",
    description: `${RECALL_SEARCH_MEMORY_DESCRIPTION[0]?.toUpperCase()}${RECALL_SEARCH_MEMORY_DESCRIPTION.slice(1)}`,
    parameters: {
      type: "object",
      properties: {
        terms: {
          type: "array",
          items: { type: "string" },
          description: "2-8 concrete search terms.",
        },
      },
      required: ["terms"],
      additionalProperties: false,
    } as unknown as Tool["parameters"],
  },
  {
    name: "search",
    description: `${RECALL_SEARCH_DESCRIPTION[0]?.toUpperCase()}${RECALL_SEARCH_DESCRIPTION.slice(1)}`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Concrete nouns: names, places, file paths, slugs, error text — not status/filler words.",
        },
        limit: {
          type: "number",
          description: "Max results (default 12, max 25).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as unknown as Tool["parameters"],
  },
];

/** The one legitimate no-result answer — everything else is an error. */
export const RECALL_NO_MATCH_TEXT = "Nothing relevant found.";
/**
 * Failure outcomes get texts DISTINCT from the no-match answer so the
 * orchestrator can tell "searched and found nothing" from "the lookup
 * itself failed" — the latter previously masqueraded as a confident miss.
 */
export const RECALL_EMPTY_BRIEF_TEXT =
  "Recall failed: the model returned an empty brief. This is a lookup failure, NOT evidence that nothing exists — retry with concrete anchors (thread ids, file names, exact phrases).";
export const RECALL_NO_OUTPUT_TEXT =
  "Recall failed: the model produced no usable output. This is a lookup failure, NOT evidence that nothing exists — retry with concrete anchors (thread ids, file names, exact phrases).";
export const RECALL_BUDGET_EXHAUSTED_TEXT =
  "Recall failed: search-step budget exhausted without a final answer. Retry with concrete anchors (thread ids, file names, exact phrases).";

/**
 * Recall internals go to stderr as JSON lines (the same channel as the
 * working-indicator traces, landing in runtime.log), so a bad answer is
 * reconstructable after the fact: which actions ran, how big each
 * observation was, and how the run ended. Before this, only the final brief
 * was persisted and every miss was undiagnosable.
 *
 * The always-on trace is STRUCTURAL only (step, action kind, sizes,
 * outcome) — runtime.log should not accumulate memory/transcript content.
 * Content previews (prompt, queries, observations, brief) are included only
 * when STELLA_RECALL_TRACE_VERBOSE is set for a debugging session.
 */
const logRecallTrace = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  try {
    process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
  } catch {
    // Tracing must never break a lookup.
  }
};

const recallTraceVerbose = (): boolean => {
  const flag = process.env.STELLA_RECALL_TRACE_VERBOSE?.trim().toLowerCase();
  return flag === "1" || flag === "true";
};

const previewForTrace = (value: string, maxChars = 300): string => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars
    ? collapsed
    : `${collapsed.slice(0, maxChars)}…`;
};

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n...[truncated]`;

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const formatLatestLocalContext = (events: LocalContextEvent[]): string => {
  const rows: string[] = [];
  for (
    let index = events.length - 1;
    index >= 0 && rows.length < 5;
    index -= 1
  ) {
    const payload = asObject(events[index]?.payload);
    const metadata = asObject(payload.metadata);
    const context = asObject(metadata.context);
    const parts: string[] = [];
    const windowLabel = context.windowLabel;
    const appSelectionLabel = context.appSelectionLabel;
    const windowPreviewImageUrl = context.windowPreviewImageUrl;
    const browserUrl = context.browserUrl;
    if (typeof windowLabel === "string" && windowLabel.trim()) {
      parts.push(`active window: ${windowLabel.trim()}`);
    }
    if (typeof appSelectionLabel === "string" && appSelectionLabel.trim()) {
      parts.push(`selected area: ${appSelectionLabel.trim()}`);
    }
    if (
      typeof windowPreviewImageUrl === "string" &&
      windowPreviewImageUrl.trim()
    ) {
      parts.push("active-window screenshot was attached");
    }
    if (typeof browserUrl === "string" && browserUrl.trim()) {
      parts.push(`browser URL: ${browserUrl.trim()}`);
    }
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.length
      : 0;
    if (attachments > 0) {
      parts.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
    }
    if (parts.length > 0) rows.push(`- ${parts.join("; ")}`);
  }
  return rows.length > 0
    ? rows.join("\n")
    : "No app, browser, selection, or attachment metadata is available.";
};

const formatLiveAppBrowserContext = (
  snapshot: HostAppBrowserContextSnapshot | undefined,
): string => {
  const rows: string[] = [];
  const tab = snapshot?.activeBrowserTab;
  if (tab) {
    rows.push(
      [
        "- active browser tab:",
        `  browser: ${tab.browser}`,
        ...(tab.title?.trim() ? [`  title: ${tab.title.trim()}`] : []),
        `  url: ${tab.url}`,
      ].join("\n"),
    );
  }
  for (const app of snapshot?.apps ?? []) {
    const parts = [
      app.isActive ? "frontmost" : "recent",
      app.name,
      app.windowTitle?.trim() ? `window: ${app.windowTitle.trim()}` : "",
      app.bundleId?.trim() ? `bundle: ${app.bundleId.trim()}` : "",
    ].filter(Boolean);
    if (parts.length > 0) rows.push(`- ${parts.join("; ")}`);
  }
  return rows.length > 0
    ? rows.join("\n")
    : "No live app or browser-tab snapshot is available.";
};

const normalizeMemorySearchTerms = (terms?: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const term of terms ?? []) {
    const trimmed = term.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const capped = trimmed.slice(0, MAX_MEMORY_SEARCH_TERM_CHARS);
    const key = capped.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(capped);
    if (normalized.length >= MAX_MEMORY_SEARCH_TERMS) break;
  }
  return normalized;
};

type MemoryFileSource = {
  displayPath: string;
  path: string;
  includeByDefault: boolean;
};

const MEMORY_FILE_SOURCES = (stellaDataDir: string): MemoryFileSource[] => [
  {
    displayPath: "~/.stella/memories/memory_summary.md",
    path: path.join(stellaDataDir, "memories", "memory_summary.md"),
    includeByDefault: true,
  },
  {
    displayPath: "~/.stella/memories/MEMORY.md",
    path: path.join(stellaDataDir, "memories", "MEMORY.md"),
    includeByDefault: true,
  },
];

const readMemoryFiles = async (
  stellaDataDir: string,
  opts?: { hasSearchTerms?: boolean },
): Promise<string> => {
  const files = [
    ...MEMORY_FILE_SOURCES(stellaDataDir).filter(
      (file) =>
        file.includeByDefault &&
        (!opts?.hasSearchTerms ||
          file.displayPath !== "~/.stella/memories/MEMORY.md"),
    ),
  ];
  const blocks: string[] = [];
  for (const file of files) {
    const content = await readOptionalTextFile(file.path);
    if (!content) continue;
    const rendered = truncate(
      sanitizePromptContext(content, file.displayPath),
      EAGER_MEMORY_FILE_CHAR_BUDGET,
    );
    blocks.push(
      `<memory_file path="${file.displayPath}">\n${rendered}\n</memory_file>`,
    );
  }
  if (blocks.length === 0) return "No memory files found.";
  if (opts?.hasSearchTerms) {
    blocks.push(
      "Full ~/.stella/memories/MEMORY.md omitted because memorySearchTerms were provided. Use # Memory Search Results for matched lines.",
    );
  }
  return blocks.join("\n\n");
};

const lineMatchesTerms = (
  line: string,
  normalizedTerms: string[],
): string[] => {
  const lower = line.toLocaleLowerCase();
  return normalizedTerms.filter((term) =>
    lower.includes(term.toLocaleLowerCase()),
  );
};

const formatLineRange = (start: number, end: number): string =>
  start === end ? String(start) : `${start}-${end}`;

const readMemorySearchResults = async (
  stellaDataDir: string,
  searchTerms?: readonly string[],
): Promise<string> => {
  const terms = normalizeMemorySearchTerms(searchTerms);
  if (terms.length === 0) {
    return "No memory search terms provided.";
  }

  const blocks: string[] = [
    `<memory_search terms="${escapeAttribute(terms.join(", "))}">`,
  ];
  let matchCount = 0;
  let truncated = false;

  for (const file of MEMORY_FILE_SOURCES(stellaDataDir)) {
    const content = await readOptionalTextFile(file.path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const usedRanges: Array<{ start: number; end: number }> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const matchedTerms = lineMatchesTerms(lines[index] ?? "", terms);
      if (matchedTerms.length === 0) continue;

      const start = Math.max(0, index - MAX_MEMORY_SEARCH_CONTEXT_LINES);
      const end = Math.min(
        lines.length - 1,
        index + MAX_MEMORY_SEARCH_CONTEXT_LINES,
      );
      const previous = usedRanges[usedRanges.length - 1];
      if (previous && start <= previous.end) {
        previous.end = Math.max(previous.end, end);
        continue;
      }
      usedRanges.push({ start, end });
    }

    for (const range of usedRanges) {
      if (matchCount >= MAX_MEMORY_SEARCH_MATCHES) {
        truncated = true;
        break;
      }
      const numbered = lines
        .slice(range.start, range.end + 1)
        .map((line, offset) => `${range.start + offset + 1}: ${line}`)
        .join("\n");
      const rangeText = formatLineRange(range.start + 1, range.end + 1);
      blocks.push(
        [
          `<match path="${escapeAttribute(file.displayPath)}" lines="${rangeText}">`,
          sanitizeToolVisibleText(numbered),
          "</match>",
        ].join("\n"),
      );
      matchCount += 1;
      if (blocks.join("\n\n").length > MAX_MEMORY_SEARCH_RESULTS_CHARS) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (matchCount === 0) {
    blocks.push("No matching memory lines found.");
  }
  if (truncated) {
    blocks.push(
      `[truncated after ${matchCount} matches; narrow or change memorySearchTerms for more precise recall]`,
    );
  }
  blocks.push("</memory_search>");
  return blocks.join("\n\n");
};

const readChronicleFiles = async (stellaDataDir: string): Promise<string> => {
  const files = [
    { name: "10m-current.md", label: "last ~10 minutes" },
    { name: "6h-current.md", label: "last ~6 hours" },
  ];
  const blocks: string[] = [];
  for (const file of files) {
    const displayPath = path.posix.join(...CHRONICLE_DIR_SEGMENTS, file.name);
    const content = await readOptionalTextFile(
      path.join(stellaDataDir, ...CHRONICLE_DIR_SEGMENTS, file.name),
    );
    if (!content) continue;
    blocks.push(
      `<chronicle_snapshot window="${file.label}" path="${displayPath}">\n${content}\n</chronicle_snapshot>`,
    );
  }
  return blocks.length > 0
    ? blocks.join("\n\n")
    : "No Chronicle summaries found.";
};

const formatClockTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

/**
 * Live-progress lines for one thread: the latest timestamped progress
 * phrases the UI's progress-summary engine generated for the agent, read
 * from the persisted per-agent ring buffer. Only rendered for threads that
 * are ACTIVE right now — a paused/finished thread's last phrases describe
 * work that already stopped and would read as live status.
 */
const formatThreadLiveProgressLines = (
  store: Pick<ContextLookupStore, "listAgentProgressSummaries">,
  thread: { threadId: string; agentStatus?: unknown },
): string[] => {
  if (
    deriveRuntimeThreadLiveState(
      thread as Parameters<typeof deriveRuntimeThreadLiveState>[0],
    ) !== "active"
  ) {
    return [];
  }
  let entries: Array<{ text: string; atMs: number }>;
  try {
    entries = store.listAgentProgressSummaries(
      thread.threadId,
      MAX_LIVE_PROGRESS_SUMMARIES,
    );
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  return [
    "  live progress (newest last):",
    ...entries.map(
      (entry) =>
        `    - [${formatClockTime(entry.atMs)}] ${sanitizeToolVisibleText(
          entry.text,
        )}`,
    ),
  ];
};

/** Index limit for this call: widened when the last day was high-volume. */
export const resolveRecallIndexLimit = (
  store: Pick<ContextLookupStore, "countThreadsCreatedSince">,
  now = Date.now(),
): number =>
  store.countThreadsCreatedSince(now - DAY_MS) >=
  RECALL_INDEX_HIGH_VOLUME_DAILY_THREADS
    ? RECALL_INDEX_HIGH_VOLUME_LIMIT
    : RECALL_INDEX_BASE_LIMIT;

const formatIndexTimestamp = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export type RecallThreadIndexSections = {
  /**
   * The "# Thread Index" body: every entry's STABLE fields, ordered oldest →
   * newest by last-active so churn concentrates at the end. Prefix stability
   * for prompt caching is PARTIAL, not absolute: within a burst of recall
   * calls the head is byte-stable, but once the rolling window is full each
   * new thread evicts the oldest entry and shifts the head. Good enough for
   * the burst-of-lookups case caching actually serves; an append-only pinned
   * prefix was deliberately not worth the bookkeeping.
   */
  index: string;
  /**
   * The volatile "# Live Thread Status" tail: only the threads executing a
   * turn right now, with their latest timestamped progress phrases. Any
   * indexed thread absent here is paused (idle but resumable).
   */
  liveStatus: string;
};

/**
 * Recall's inline thread index — the replacement for query-based thread
 * search. The model reads the full index (most recent `limit` threads across
 * ALL conversations, including evicted ones) and identifies candidates
 * directly, so a status lookup no longer depends on the phrasing of the
 * question or on lexical token overlap.
 */
export const formatRecallThreadIndex = (
  store: ContextLookupStore,
  now = Date.now(),
): RecallThreadIndexSections => {
  const limit = resolveRecallIndexLimit(store, now);
  const threads = store.listThreadsForRecallIndex({ limit });
  if (threads.length === 0) {
    return {
      index: "No delegated agent threads recorded yet.",
      liveStatus: "No agent threads are executing a turn right now.",
    };
  }
  const ordered = [...threads].sort(
    (a, b) =>
      runtimeThreadLastActiveAt(a) - runtimeThreadLastActiveAt(b) ||
      a.threadId.localeCompare(b.threadId),
  );
  // Enforce the rendered-char budget newest-first: keep the most recent
  // entries whole, drop entire oldest entries once the budget is spent.
  const rendered = ordered.map((thread) =>
    formatRecallIndexEntry(thread, now),
  );
  let keptChars = 0;
  let firstKept = rendered.length;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const cost = rendered[i]!.length + 1;
    if (keptChars + cost > RECALL_INDEX_CHAR_BUDGET) break;
    keptChars += cost;
    firstKept = i;
  }
  const dropped = firstKept;
  const kept = rendered.slice(firstKept);
  const index = [
    ...(dropped > 0
      ? [
          `[index truncated to fit its budget: showing the ${kept.length} most recently active of ${rendered.length} threads; ${dropped} older entries omitted]`,
        ]
      : []),
    ...kept,
  ].join("\n");
  const running = ordered.filter(
    (thread) => deriveRuntimeThreadLiveState(thread) === "active",
  );
  const liveStatus =
    running.length === 0
      ? "No agent threads are executing a turn right now; every indexed thread is paused (idle but resumable)."
      : running
          .map((thread) =>
            [
              `- ${thread.threadId} (${formatRuntimeThreadStatusSuffix(thread, now)})`,
              ...formatThreadLiveProgressLines(store, thread),
            ].join("\n"),
          )
          .join("\n");
  return { index, liveStatus };
};

/**
 * One dense index entry. Only STABLE fields live here (id, name,
 * description, last-active timestamp, result/error excerpts) — live
 * active/paused state is deliberately left to the volatile tail so a
 * thread's entry stops changing once it goes quiet.
 */
const formatRecallIndexEntry = (
  thread: RecallIndexThreadRow,
  now: number,
): string => {
  const name = collapseWhitespace(thread.name);
  const description = thread.description
    ? collapseWhitespace(thread.description).slice(
        0,
        RECALL_INDEX_DESCRIPTION_CHARS,
      )
    : "";
  const lastActive = Math.min(runtimeThreadLastActiveAt(thread), now);
  const lines = [
    `- ${thread.threadId} | last active ${formatIndexTimestamp(lastActive)} | ${sanitizeToolVisibleText(name)}`,
  ];
  // Names are minted from descriptions, so most pairs are identical — only
  // render a description that adds information.
  if (description && description !== name) {
    lines.push(`  description: ${sanitizeToolVisibleText(description)}`);
  }
  if (thread.resultExcerpt) {
    lines.push(
      `  result: ${sanitizeToolVisibleText(collapseWhitespace(thread.resultExcerpt))}`,
    );
  }
  if (thread.errorExcerpt) {
    lines.push(
      `  error: ${sanitizeToolVisibleText(collapseWhitespace(thread.errorExcerpt))}`,
    );
  }
  return lines.join("\n");
};

export const buildContextLookupUserPrompt = async (args: {
  conversationId: string;
  lookupPrompt: string;
  memorySearchTerms?: readonly string[];
  stellaDataDir: string;
  store: ContextLookupStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
}): Promise<string> => {
  const normalizedSearchTerms = normalizeMemorySearchTerms(
    args.memorySearchTerms,
  );
  const hasSearchTerms = normalizedSearchTerms.length > 0;
  const [memoryFiles, memorySearchResults, chronicleFiles] = await Promise.all([
    readMemoryFiles(args.stellaDataDir, {
      hasSearchTerms,
    }),
    hasSearchTerms
      ? readMemorySearchResults(args.stellaDataDir, normalizedSearchTerms)
      : Promise.resolve(""),
    readChronicleFiles(args.stellaDataDir),
  ]);

  const threadIndex = formatRecallThreadIndex(args.store);

  // Section order is stable → volatile: the big thread index leads so its
  // prefix stays cacheable across calls, live/current state follows, and the
  // lookup request comes LAST so it sits closest to the model's answer.
  const sections = [
    "# Thread Index",
    "Every delegated agent thread Stella has run recently (most recent first-class threads across ALL conversations, including evicted ones), oldest → newest by last activity. Each entry: thread_id | last active | name, plus description, final-result excerpt, and error when recorded.",
    threadIndex.index,
    "",
    "# Memory Files",
    memoryFiles,
  ];
  if (hasSearchTerms) {
    sections.push("", "# Memory Search Results", memorySearchResults);
  }
  sections.push(
    "",
    "# Current Time",
    // Anchors the whole lookup to "now": thread status, live-progress
    // timestamps, and recency phrases are all relative to this moment.
    formatDateTimeReminder(Date.now()),
    "",
    "# Local App And Browser Context",
    formatLiveAppBrowserContext(args.appBrowserContext),
    "",
    "# Message-Attached App And Browser Context",
    formatLatestLocalContext(args.localEvents),
    "",
    "# Live Thread Status",
    "Threads executing a turn RIGHT NOW, with their latest timestamped progress phrases. Any indexed thread not listed here is paused (idle but resumable) as of the current time above.",
    threadIndex.liveStatus,
    "",
    "# Chronicle Context",
    chronicleFiles,
    "",
    "# Lookup Request",
    truncate(args.lookupPrompt.trim(), 2_000),
  );
  return sections.join("\n");
};

const MESSAGE_SNIPPET_CHAR_BUDGET = 360;

const formatSnippetDate = (atMs: number): string =>
  new Date(atMs).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

/** Window a matched transcript text around its first matching token. */
const buildMessageSnippet = (text: string, tokens: string[]): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MESSAGE_SNIPPET_CHAR_BUDGET) return collapsed;
  const lower = collapsed.toLocaleLowerCase();
  let matchIndex = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token.toLocaleLowerCase());
    if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
      matchIndex = index;
    }
  }
  const center = matchIndex === -1 ? 0 : matchIndex;
  const start = Math.max(
    0,
    center - Math.floor(MESSAGE_SNIPPET_CHAR_BUDGET / 2),
  );
  const end = Math.min(collapsed.length, start + MESSAGE_SNIPPET_CHAR_BUDGET);
  return `${start > 0 ? "…" : ""}${collapsed.slice(start, end)}${
    end < collapsed.length ? "…" : ""
  }`;
};

type UnifiedSearchEntry = {
  score: number;
  sameConversation: boolean;
  recency: number;
  rendered: string;
  /** Present on message entries so top hits can expand neighbor context. */
  hit?: { conversationId: string; atMs: number };
};

/**
 * How many distinct EPISODES get surrounding-context lines (episode dedupe
 * below keeps same-hour repeat hits from burning slots, so in practice this
 * covers nearly every distinct episode in a 12-result page).
 */
const MESSAGE_CONTEXT_TOP_HITS = 8;
const MESSAGE_CONTEXT_LINE_CHAR_BUDGET = 170;
// The follow-through usually comes AFTER the matched message (ask for
// directions → go → react, sometimes an hour later), so the exchange
// window leans hard forward; the store also time-boxes it to the episode.
const MESSAGE_CONTEXT_BEFORE = 2;
const MESSAGE_CONTEXT_AFTER = 8;
// Two hits this close together in one conversation are the same episode —
// one exchange covers both, so the second hit's slot goes to a new episode.
const MESSAGE_EPISODE_WINDOW_MS = 45 * 60 * 1000;

/**
 * The recall agent's single `search` action: one query over BOTH sources —
 * past delegated agent work (thread metadata, current-conversation hits
 * first) and past conversation transcripts (what the user and Stella
 * actually said, across ALL conversations). Results merge into one
 * relevance-ranked list; each entry is typed (`[agent thread]` with a
 * resumable thread_id/status/summary vs `[message]` with a dated snippet
 * and conversation scope) so the model never has to pre-choose a source.
 */
export const formatUnifiedSearch = (
  store: Pick<
    RuntimeStore,
    | "searchThreads"
    | "searchTranscripts"
    | "listTranscriptNeighbors"
    | "listAgentProgressSummaries"
  >,
  conversationId: string,
  query: string | undefined,
  limit: number | undefined,
): string => {
  const cappedLimit = Math.max(1, Math.min(25, Math.floor(limit ?? 12)));
  const tokens = tokenizeSearchQuery(query);
  // Both stores already rank internally; this rescoring exists so the two
  // result types can interleave in ONE list under the same metric (matched
  // token count, then current-conversation, then recency).
  const countTokenHits = (
    haystacks: Array<string | undefined | null>,
  ): number => {
    const lowered = haystacks
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => entry.toLocaleLowerCase());
    return tokens.filter((token) => {
      const needle = token.toLocaleLowerCase();
      return lowered.some((haystack) => haystack.includes(needle));
    }).length;
  };

  const threads = store.searchThreads({
    conversationId,
    ...(query ? { query } : {}),
    limit: cappedLimit,
  });
  const messageHits =
    tokens.length > 0
      ? store.searchTranscripts({ query: query ?? "", limit: cappedLimit })
      : [];

  const entries: UnifiedSearchEntry[] = [];
  for (const thread of threads) {
    const summary = thread.summary?.trim().replace(/\s+/g, " ").slice(0, 300);
    const sameConversation = thread.conversationId === conversationId;
    const rendered = [
      // Same live active/paused signal and last-active recency as the
      // orchestrator's "# Other Threads" roster, so a Recall query about
      // thread status answers with real state instead of a flat label.
      `- [agent thread] ${thread.threadId} (${formatRuntimeThreadStatusSuffix(thread)}; from ${sameConversation ? "this conversation" : "another conversation"})`,
      thread.description?.trim()
        ? `  description: ${thread.description.trim()}`
        : "",
      summary ? `  summary: ${summary}` : "",
      ...formatThreadLiveProgressLines(store, thread),
    ]
      .filter(Boolean)
      .join("\n");
    entries.push({
      score: countTokenHits([
        thread.threadId,
        thread.name,
        thread.summary,
        thread.description,
        thread.groupLabel,
        thread.groupKey,
      ]),
      sameConversation,
      recency: thread.lastUsedAt,
      rendered,
    });
  }
  for (const hit of messageHits) {
    const sameConversation = hit.conversationId === conversationId;
    // A short conversation tag (instead of a bare "another conversation")
    // lets the model tell that several hits came from the SAME earlier
    // conversation — that co-location is often the story ("that evening").
    const scope = sameConversation
      ? "this conversation"
      : `conversation …${hit.conversationId.slice(-6)}`;
    entries.push({
      score: countTokenHits([hit.text]),
      sameConversation,
      recency: hit.atMs,
      rendered: `- [message] [${formatSnippetDate(hit.atMs)}] ${hit.role === "user" ? "User" : "Stella"} (${scope}): ${sanitizeToolVisibleText(buildMessageSnippet(hit.text, tokens))}`,
      hit: { conversationId: hit.conversationId, atMs: hit.atMs },
    });
  }

  if (entries.length === 0) {
    return query
      ? "Nothing matched — no past agent work and no chat messages. Try fewer/different words, or omit the query to browse recent work."
      : "No past agent work recorded yet.";
  }
  entries.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.sameConversation) - Number(a.sameConversation) ||
      b.recency - a.recency,
  );
  const selected = entries.slice(0, cappedLimit);

  // Relevance decides WHICH message hits get their surrounding exchange;
  // hits inside an already-expanded episode don't burn a second slot.
  const expandable = new Set<UnifiedSearchEntry>();
  for (const entry of selected) {
    if (!entry.hit || expandable.size >= MESSAGE_CONTEXT_TOP_HITS) continue;
    const withinExpandedEpisode = [...expandable].some(
      (other) =>
        other.hit &&
        entry.hit &&
        other.hit.conversationId === entry.hit.conversationId &&
        Math.abs(other.hit.atMs - entry.hit.atMs) <= MESSAGE_EPISODE_WINDOW_MS,
    );
    if (withinExpandedEpisode) continue;
    expandable.add(entry);
  }

  // Expand a message hit with the surrounding exchange: the matched message
  // names the thing, but the neighbors are usually the event itself. Only
  // the most relevant few get this so the observation stays tight.
  const renderEntry = (entry: UnifiedSearchEntry): string => {
    if (!entry.hit || !expandable.has(entry)) return entry.rendered;
    let neighbors: ReturnType<RuntimeStore["listTranscriptNeighbors"]>;
    try {
      neighbors = store.listTranscriptNeighbors({
        conversationId: entry.hit.conversationId,
        atMs: entry.hit.atMs,
        before: MESSAGE_CONTEXT_BEFORE,
        after: MESSAGE_CONTEXT_AFTER,
      });
    } catch {
      return entry.rendered;
    }
    if (neighbors.length === 0) return entry.rendered;
    const contextLines = neighbors.map((neighbor) => {
      const collapsed = neighbor.text.replace(/\s+/g, " ").trim();
      const clipped =
        collapsed.length <= MESSAGE_CONTEXT_LINE_CHAR_BUDGET
          ? collapsed
          : `${collapsed.slice(0, MESSAGE_CONTEXT_LINE_CHAR_BUDGET)}…`;
      return `    [${formatSnippetDate(neighbor.atMs)}] ${neighbor.role === "user" ? "User" : "Stella"}: ${sanitizeToolVisibleText(clipped)}`;
    });
    return [entry.rendered, "  surrounding exchange:", ...contextLines].join(
      "\n",
    );
  };

  // ...but the LIST presents agent threads first (by relevance), then the
  // selected message hits in chronological order — episodic questions are
  // answered by reading the messages as a timeline, and models reliably
  // misread "first/last time" from a relevance-shuffled list.
  const threadLines = selected
    .filter((entry) => !entry.hit)
    .map((entry) => renderEntry(entry));
  const messageLines = selected
    .filter((entry) => entry.hit)
    .sort((a, b) => a.recency - b.recency)
    .map((entry) => renderEntry(entry));
  return [
    ...threadLines,
    ...(messageLines.length > 0
      ? ["[message results below, oldest → newest]", ...messageLines]
      : []),
  ].join("\n");
};

type RecallAction =
  | { action: "search_memory"; terms: string[] }
  | { action: "search"; query?: string; limit?: number }
  | { action: "answer"; brief: string };

/** Pull the first JSON object out of a model turn (tolerates fences/prose). */
const extractJsonObject = (raw: string): string | null => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? (fenced[1] ?? "") : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
};

export const parseRecallAction = (raw: string): RecallAction | null => {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepair<unknown>(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.action === "answer") {
    return { action: "answer", brief: typeof obj.brief === "string" ? obj.brief : "" };
  }
  if (obj.action === "search_memory") {
    const terms = Array.isArray(obj.terms)
      ? obj.terms.filter((term): term is string => typeof term === "string")
      : [];
    return { action: "search_memory", terms };
  }
  // "search_threads" is the pre-unification action name; models
  // occasionally echo action names they saw in older transcripts, so it
  // (and the briefly-used split names) all resolve to the unified search.
  if (
    obj.action === "search" ||
    obj.action === "search_threads" ||
    obj.action === "search_agents" ||
    obj.action === "search_messages"
  ) {
    return {
      action: "search",
      ...(typeof obj.query === "string" ? { query: obj.query } : {}),
      ...(typeof obj.limit === "number" ? { limit: obj.limit } : {}),
    };
  }
  return null;
};

/**
 * Agent-backed recall. Seeds the model with the cheap eager context (memory
 * summary, capped ledger, live app/browser state, recent activity, active
 * threads, chronicle), then runs a bounded JSON-action loop where the model
 * decides what to search — the deep memory ledger and/or the unified search
 * over past delegated agent work plus past chat transcripts across all
 * conversations — before synthesizing a brief. Replaces the old one-shot
 * lookup and subsumes the standalone thread-search tool. Runs synchronously
 * as the `Recall` tool's backing.
 */
export const runRecall = async (args: {
  conversationId: string;
  lookupPrompt: string;
  memorySearchTerms?: readonly string[];
  stellaAppDir: string;
  stellaDataDir: string;
  store: RuntimeStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
  resolvedLlm: ResolvedLlmRoute;
  signal?: AbortSignal;
}): Promise<string> => {
  const seed = await buildContextLookupUserPrompt({
    conversationId: args.conversationId,
    lookupPrompt: args.lookupPrompt,
    // memorySearchTerms intentionally omitted from the seed — the recall agent
    // issues its own searches; any orchestrator-provided terms pre-seed below.
    stellaDataDir: args.stellaDataDir,
    store: args.store,
    localEvents: args.localEvents,
    ...(args.appBrowserContext
      ? { appBrowserContext: args.appBrowserContext }
      : {}),
  });

  // Engine preferences live in the data dir (`~/.stella/preferences.json`) —
  // same detection the one-shot completion path uses. When the Claude Code
  // engine is active, the run needs no route credential and the engine maps a
  // pinned `stella/light` model id to its own light model (haiku).
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: args.stellaDataDir,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : (await args.resolvedLlm.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    return "Recall is unavailable because no model credential is configured.";
  }

  const verbose = recallTraceVerbose();
  let scratchpad = "";
  let ranSearch = false;

  /** Run one search action against the real backends (shared by both engines). */
  const executeSearchAction = async (
    action: Exclude<RecallAction, { action: "answer" }>,
  ): Promise<string> => {
    if (action.action === "search") ranSearch = true;
    return action.action === "search_memory"
      ? await readMemorySearchResults(args.stellaDataDir, action.terms)
      : formatUnifiedSearch(
          args.store,
          args.conversationId,
          action.query,
          action.limit,
        );
  };

  /** Trace the search and append it to the scratchpad the next step sees. */
  const recordSearchObservation = (
    step: number | string,
    action: Exclude<RecallAction, { action: "answer" }>,
    observation: string,
  ): void => {
    logRecallTrace("[stella:recall:step]", {
      conversationId: args.conversationId,
      step,
      action: action.action,
      observationChars: observation.length,
      // Search terms/queries and observation content are user data — only
      // traced when explicitly debugging.
      ...(verbose
        ? {
            actionDetail:
              action.action === "search_memory"
                ? { terms: action.terms }
                : { query: action.query ?? null },
            observationPreview: previewForTrace(observation),
          }
        : {}),
    });
    scratchpad += `\nAction: ${JSON.stringify(action)}\nObservation:\n${truncate(observation, RECALL_OBSERVATION_CHAR_BUDGET)}\n`;
  };

  /**
   * The Claude Code engine's tool bridge: the CLI runtime advertises
   * `RECALL_RUNTIME_TOOLS` and routes each `tool_request` here, onto the
   * same search backends the JSON-action loop uses. Without this, the run
   * carried an EMPTY tool list and no executor, so every search attempt got
   * "Tool search is not available in this run." and recall silently degraded
   * to the seed context (thread index + memory summaries only).
   */
  let toolCallCount = 0;
  const executeRecallToolCall = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: string }> => {
    const action = parseRecallAction(
      JSON.stringify({ ...toolArgs, action: toolName }),
    );
    if (!action || action.action === "answer") {
      return {
        error: `Unknown tool "${toolName}". Use search_memory or search, or reply with the final brief as plain text.`,
      };
    }
    const observation = await executeSearchAction(action);
    recordSearchObservation(`tool:${toolCallCount++}`, action, observation);
    return { result: observation };
  };

  const step = async (userText: string): Promise<string> => {
    const context: Context = {
      systemPrompt: useClaudeCode
        ? RECALL_TOOL_RUNTIME_SYSTEM_PROMPT
        : RECALL_SYSTEM_PROMPT,
      ...(useClaudeCode ? { tools: RECALL_RUNTIME_TOOLS } : {}),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userText }],
          timestamp: Date.now(),
        } satisfies Message,
      ],
    };
    if (useClaudeCode) {
      const text = await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaAppDir,
        agentType: AGENT_IDS.ORCHESTRATOR,
        stellaModel: args.resolvedLlm.model.id,
        context,
        abortSignal: args.signal,
        executeTool: async (_toolCallId, toolName, toolArgs) =>
          executeRecallToolCall(toolName, toolArgs),
      });
      return text.trim();
    }
    const response: AssistantMessage = await completeSimple(
      args.resolvedLlm.model,
      context,
      {
        apiKey: apiKey as string,
        ...(args.resolvedLlm.refreshApiKey
          ? { refreshApiKey: args.resolvedLlm.refreshApiKey }
          : {}),
        maxTokens: MAX_CONTEXT_OUTPUT_TOKENS,
        temperature: 0,
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
    return readAssistantText(response).trim();
  };

  const buildTurn = (scratchpad: string, closer: string): string =>
    [
      seed,
      scratchpad ? `\n# Steps so far\n${scratchpad}` : "",
      `\n# Next\n${closer}`,
    ].join("\n");

  logRecallTrace("[stella:recall:start]", {
    conversationId: args.conversationId,
    promptChars: args.lookupPrompt.length,
    seedChars: seed.length,
    ...(verbose
      ? { promptPreview: previewForTrace(args.lookupPrompt, 200) }
      : {}),
  });
  const finish = (outcome: string, brief: string): string => {
    logRecallTrace("[stella:recall:answer]", {
      conversationId: args.conversationId,
      outcome,
      briefChars: brief.length,
      ...(verbose ? { briefPreview: previewForTrace(brief) } : {}),
    });
    return brief;
  };

  // Honor an orchestrator-provided search hint as a pre-run observation.
  const seedTerms = normalizeMemorySearchTerms(args.memorySearchTerms);
  if (seedTerms.length > 0) {
    const initial = await readMemorySearchResults(args.stellaDataDir, seedTerms);
    scratchpad += `\nAction: ${JSON.stringify({ action: "search_memory", terms: seedTerms })}\nObservation:\n${truncate(initial, RECALL_OBSERVATION_CHAR_BUDGET)}\n`;
  }

  const isNothingFoundBrief = (brief: string): boolean =>
    brief.trim().toLocaleLowerCase().startsWith("nothing relevant found");
  let rejectedUnsearchedNothingFound = false;

  // A nothing-found verdict without a single search behind it is the exact
  // failure mode observed in the field (the model glancing past the context
  // and giving up) — reject it ONCE and demand a search. Applies to both the
  // JSON-action form and the plain-prose form the external engine produces.
  const rejectUnsearchedNothingFound = (
    stepIndex: number,
    echo: string,
  ): boolean => {
    if (
      ranSearch ||
      rejectedUnsearchedNothingFound ||
      stepIndex >= MAX_RECALL_STEPS - 1
    ) {
      return false;
    }
    rejectedUnsearchedNothingFound = true;
    logRecallTrace("[stella:recall:step]", {
      conversationId: args.conversationId,
      step: stepIndex,
      action: "answer-rejected",
      reason: "nothing-found-without-search",
    });
    const searchHint = useClaudeCode ? "the `search` tool" : '{"action":"search"}';
    scratchpad += `\nAction: ${echo}\nObservation:\nRejected: you answered "Nothing relevant found." without running a single search. Re-scan the # Thread Index for candidates, and run ${searchHint} with concrete terms from the lookup request (names, slugs, file paths — not status words) before concluding nothing exists.\n`;
    return true;
  };

  const stepCloser = useClaudeCode
    ? "Call `search_memory`/`search` if you still need evidence; otherwise reply with the final concise brief as plain text."
    : 'Respond with one JSON action ({"action":"search_memory"|"search"|"answer", ...}).';

  for (let i = 0; i < MAX_RECALL_STEPS; i += 1) {
    const raw = await step(buildTurn(scratchpad, stepCloser));
    const action = parseRecallAction(raw);
    if (!action) {
      // Model returned prose instead of JSON — that is the answer (and the
      // only shape an external-engine final can take). A prose "nothing
      // found" gets the same one-time unsearched rejection as the JSON form.
      if (
        raw &&
        isNothingFoundBrief(raw) &&
        rejectUnsearchedNothingFound(i, JSON.stringify(previewForTrace(raw)))
      ) {
        continue;
      }
      logRecallTrace("[stella:recall:step]", {
        conversationId: args.conversationId,
        step: i,
        action: "unparseable",
        rawChars: raw.length,
        ...(verbose ? { rawPreview: previewForTrace(raw) } : {}),
      });
      return finish(
        raw ? "prose" : "no-output",
        raw || RECALL_NO_OUTPUT_TEXT,
      );
    }
    if (action.action === "answer") {
      const brief = action.brief.trim();
      if (
        isNothingFoundBrief(brief) &&
        rejectUnsearchedNothingFound(i, JSON.stringify(action))
      ) {
        continue;
      }
      return finish(
        brief ? "answer" : "empty-brief",
        brief || RECALL_EMPTY_BRIEF_TEXT,
      );
    }
    const observation = await executeSearchAction(action);
    recordSearchObservation(i, action, observation);
  }

  // Step budget exhausted — force a final synthesized answer.
  const finalRaw = await step(
    buildTurn(
      scratchpad,
      useClaudeCode
        ? "You are out of search steps. Reply now with the final concise brief (plain text) summarizing what you found."
        : 'You are out of search steps. Respond now with {"action":"answer","brief":"..."} summarizing what you found.',
    ),
  );
  const finalAction = parseRecallAction(finalRaw);
  if (finalAction?.action === "answer") {
    const brief = finalAction.brief.trim();
    return finish(
      brief ? "forced-answer" : "empty-brief",
      brief || RECALL_EMPTY_BRIEF_TEXT,
    );
  }
  return finish(
    finalRaw ? "forced-prose" : "budget-exhausted",
    finalRaw || RECALL_BUDGET_EXHAUSTED_TEXT,
  );
};
