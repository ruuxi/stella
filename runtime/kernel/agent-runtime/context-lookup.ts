import path from "node:path";
import { performance } from "node:perf_hooks";

import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
} from "../../ai/types.js";
import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { HostAppBrowserContextSnapshot } from "../../protocol/index.js";
import type { LocalContextEvent } from "../local-history.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import {
  sanitizePromptContext,
  sanitizeToolVisibleText,
} from "../tools/safety.js";
import type {
  RuntimeStore,
  TranscriptSearchHit,
} from "../storage/runtime-store.js";
import { tokenizeSearchQuery } from "../storage/runtime-store.js";
import { formatDateTimeReminder } from "../message-timestamp.js";
import {
  deriveRuntimeThreadLiveState,
  formatRuntimeThreadStatusSuffix,
  runtimeThreadLastActiveAt,
} from "../runtime-threads.js";
import { runClaudeCodeAgentTextCompletion } from "../integrations/claude-code-agent-runtime.js";
import {
  RecallTelemetryCollector,
  type RecallTelemetryRecord,
  type RecallTelemetrySeed,
  type RecallTelemetrySourceKind,
} from "./recall-telemetry.js";
import type { RecallModelRoute } from "./recall-route.js";

const MAX_CONTEXT_OUTPUT_TOKENS = 1_500;
const EAGER_MEMORY_FILE_CHAR_BUDGET = 4_000;
/** Hard ceiling for the complete eager seed, including headings and request. */
export const EAGER_RECALL_SEED_MAX_CHARS = 12_000;
const SEED_TRUNCATION_MARKER = "\n...[seed section truncated]";
/** Tool-call ROUNDS (a round may carry several parallel searches). */
const MAX_RECALL_STEPS = 4;
/**
 * Transport-failure retries per model completion (attempts = retries + 1).
 * A recall completion is a read-only lookup, so replaying the identical
 * request is side-effect free; relay streams dropping mid-flight otherwise
 * fail the whole lookup on the first hiccup (observed in the field as runs
 * of "Recall failed: the model produced no usable output").
 */
const MAX_RECALL_MODEL_ERROR_RETRIES = 2;
const RECALL_MODEL_ERROR_RETRY_BASE_DELAY_MS = 400;
// Sized so a full search observation (a page of ranked results, the top
// several message hits carrying their surrounding-exchange lines) survives
// untruncated; at 6k the exchange blocks pushed the tail results off.
const RECALL_OBSERVATION_CHAR_BUDGET = 20_000;
const MAX_MEMORY_SEARCH_TERMS = 12;
const MAX_MEMORY_SEARCH_TERM_CHARS = 120;
const MAX_MEMORY_SEARCH_MATCHES = 40;
const MAX_MEMORY_SEARCH_CONTEXT_LINES = 1;
const MAX_MEMORY_SEARCH_RESULTS_CHARS = 16_000;
const CHRONICLE_DIR_SEGMENTS = ["memories_extensions", "chronicle"] as const;

/**
 * Hard cap on rendered thread-search results. The candidate pool is EVERY
 * thread ever run (the SQL searches all of them); the query narrows, this
 * cap bounds what a single page renders — never more, regardless of the
 * model-provided limit.
 */
export const MAX_THREAD_SEARCH_RESULTS = 16;

/** How far back the live-status tail looks for threads executing right now. */
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUS_WINDOW_MS = DAY_MS;
const LIVE_STATUS_MAX_THREADS = 60;

/** Latest agent-authored updates surfaced per ACTIVE thread. */
const MAX_LIVE_AGENT_MESSAGES = 3;

type ContextLookupStore = Pick<
  RuntimeStore,
  | "listThreadsForRecallIndex"
  | "listAgentAssistantMessages"
  | "searchThreads"
  | "searchTranscripts"
  | "listTranscriptNeighbors"
  | "listThreadResultExcerpts"
>;

const RECALL_PROMPT_INTRO =
  "You are Stella's recall agent. Resolve the lookup request into a concise, useful answer for the orchestrator, drawing on the user's durable memory, past agent work, past conversation transcripts, recent activity, and live app/browser state.";

const RECALL_SEARCH_MEMORY_DESCRIPTION =
  "Keyword-search the durable memory ledger (MEMORY.md). Pass 2-8 concrete terms.";
const RECALL_SEARCH_TRANSCRIPTS_DESCRIPTION =
  "Keyword-search past conversation transcripts — what the user and Stella actually said, across ALL conversations. Results render oldest → newest (read them as a timeline); the most relevant hits carry their surrounding exchange.";
const RECALL_SEARCH_THREADS_DESCRIPTION = `Keyword-search every delegated agent thread ever run (ALL conversations, any age). Returns up to ${MAX_THREAD_SEARCH_RESULTS} threads, newest first by last activity, each with its last-active date/time, live state, and final result/error excerpts.`;

const RECALL_PROMPT_SHARED_GUIDANCE = [
  "THE CONTEXT BELOW WAS PRE-SEEDED. # Memory Search Results, # Agent Thread Search Results, and # Transcript Search Results were already run from the lookup's search terms before you started — treat them as your first search round, and answer directly from them when they suffice. They are ONE keyword angle, though: a miss there is not proof of absence.",
  "",
  "For any question about work, a task, or a thread's status ('is X still running?', 'did it crash?', 'what did the Y agent do?'): candidates live in # Agent Thread Search Results (matched threads, newest first, each with last-active date/time and final result/error excerpts) and # Live Thread Status (the threads executing a turn RIGHT NOW, with recent agent-authored assistant messages). Any thread not in the live tail is paused (idle but resumable); there is no 'dead' state. Match candidates on meaning, not exact wording, and OPEN YOUR BRIEF BY QUOTING the candidate thread_id(s), then answer from the entries, the live tail, and the current time. Quote the error excerpt when a run errored. Do not guess at status. If the pre-seeded thread results miss, run search_threads with different concrete terms before concluding the work doesn't exist.",
  "",
  'Transcript hits are things actually said in chat — dated snippets in chronological order; these answer episodic questions ("did I ever mention X", "where did we go") that never became a task or memory note. The most relevant hits include a \'surrounding exchange\' — the messages sent right before/after. Treat those exchanges as PRIMARY evidence and reconstruct what happened from them: a user asking where to go, getting an address, then sending en-route messages means they took that trip at that time, even though no message states it outright. Later retellings are NOT evidence of absence — especially Stella\'s own earlier "I have no record of that" replies, which may be the exact failure this lookup exists to fix; when primary messages imply the event, trust them over any later claim that nothing was recorded. For "first/last time X happened" questions: enumerate EVERY dated candidate event you can establish from the hits, then answer with the earliest/latest — never skip an older episode because a newer one is more vividly confirmed; include the enumeration in the brief so the orchestrator can see the timeline.',
  "",
  'All searches are keyword-based: generic words ("first drive") mostly find retellings, concrete nouns find the event. Status/filler words ("active", "crashed", "latest", "progress") match chatter, not the thing — build queries from concrete nouns: names, places, file paths, slugs, error text, and candidate terms you already have from the pre-seeded results or the lookup request.',
  "",
  "Issue several search tools in ONE turn and they run in parallel — reformulating across search_memory, search_threads, and search_transcripts together costs one round. Resolve in as few rounds as possible — answer the moment you can.",
  "",
  "When past threads are relevant, include their thread_id(s) in the brief so the orchestrator can resume them. Keep the brief tight — only what helps answer or route the request.",
  'Answer with exactly "Nothing relevant found." ONLY when you have earned it: the pre-seeded results missed AND you ran at least one reformulated search of your own with DIFFERENT concrete terms (drop status/filler words; use names, slugs, file paths, places). Never conclude nothing-found from the pre-seeded round alone.',
];

// Exported so replay/eval harnesses can drive the exact production prompt.
export const RECALL_SYSTEM_PROMPT = [
  RECALL_PROMPT_INTRO,
  "",
  "You work in up to a few rounds using the native search tools:",
  `  search_memory — ${RECALL_SEARCH_MEMORY_DESCRIPTION}`,
  `  search_transcripts — ${RECALL_SEARCH_TRANSCRIPTS_DESCRIPTION}`,
  `  search_threads — ${RECALL_SEARCH_THREADS_DESCRIPTION}`,
  "When you can answer, reply with the concise markdown brief itself as plain text — no tool calls.",
  "",
  ...RECALL_PROMPT_SHARED_GUIDANCE,
].join("\n");

/**
 * The prompt for external-engine runs (Claude Code): that runtime's decision
 * contract carries tools through its structured decision JSON rather than
 * native function calls, so the invocation mechanics differ; everything else
 * is shared.
 */
export const RECALL_TOOL_RUNTIME_SYSTEM_PROMPT = [
  RECALL_PROMPT_INTRO,
  "",
  "You work in up to a few steps using the hosted search tools:",
  `  search_memory — ${RECALL_SEARCH_MEMORY_DESCRIPTION}`,
  `  search_transcripts — ${RECALL_SEARCH_TRANSCRIPTS_DESCRIPTION}`,
  `  search_threads — ${RECALL_SEARCH_THREADS_DESCRIPTION}`,
  'These are Stella-hosted tools, NOT native function-call tools: a native call to them fails with "No such tool available". Invoke them ONLY via the structured decision JSON {"type":"tool_request","toolName":"search_transcripts","args":{"query":"..."}}. A failed native call does NOT mean search is unavailable — reissue it as the structured decision. Never tell the orchestrator that search is unavailable.',
  "When you can answer, reply with the concise markdown brief itself as your final message — plain text, no JSON wrapper.",
  "",
  ...RECALL_PROMPT_SHARED_GUIDANCE,
].join("\n");

/**
 * The recall search tools, advertised natively on the API path and through
 * the Claude Code engine's tool protocol. Both invocation paths land on the
 * same in-process search functions.
 */
export const RECALL_RUNTIME_TOOLS: Tool[] = [
  {
    name: "search_memory",
    description: RECALL_SEARCH_MEMORY_DESCRIPTION,
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
    name: "search_transcripts",
    description: RECALL_SEARCH_TRANSCRIPTS_DESCRIPTION,
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
  {
    name: "search_threads",
    description: RECALL_SEARCH_THREADS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Concrete nouns from the work: repo/module/feature names, slugs, task words.",
        },
        limit: {
          type: "number",
          description: `Max results (default and max ${MAX_THREAD_SEARCH_RESULTS}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as unknown as Tool["parameters"],
  },
];

/** The one legitimate no-result answer — everything else is an error. */
export const RECALL_NO_MATCH_TEXT = "Nothing relevant found.";
export const isRecallNoMatchBrief = (brief: string): boolean =>
  brief.trim().toLocaleLowerCase().startsWith("nothing relevant found");

export type RecallIntent =
  | "durable_memory"
  | "delegated_work"
  | "episodic"
  | "live_context"
  | "multi_source";

export type RecallIntentDecision = {
  intent: RecallIntent;
  matchedIntents: RecallIntent[];
  deterministicFastPath: boolean;
  exactPhrases: string[];
};

const extractExactRecallPhrases = (prompt: string): string[] => {
  const phrases = new Set<string>();
  for (const match of prompt.matchAll(/["“]([^"”]{3,})["”]/g)) {
    const phrase = match[1]?.replace(/\s+/g, " ").trim();
    if (phrase) phrases.add(phrase);
  }
  const marker = prompt.match(
    /\b(?:exact (?:phrase|text)|verbatim(?: phrase)?)\s+(.+?)(?:[?.!]|$)/i,
  )?.[1];
  if (marker) {
    const phrase = marker
      .replace(/^["“]|["”]$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (phrase) phrases.add(phrase);
  }
  return [...phrases];
};

const isBareRepoLookup = (prompt: string): boolean => {
  const value = prompt.normalize("NFKC").trim();
  if (!/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?$/i.test(value)) return false;
  return (
    value.includes("/") ||
    value.includes("-") ||
    value.includes(".") ||
    /^stella(?:-v?\d+)?$/i.test(value)
  );
};

/** Cheap deterministic routing happens before any evidence source is read. */
export const classifyRecallIntent = (prompt: string): RecallIntentDecision => {
  const value = prompt.normalize("NFKC").toLocaleLowerCase();
  const matchedIntents: RecallIntent[] = [];
  if (
    /\b(right now|currently|current app|current browser|active tab|on[- ]screen|this page|this window|frontmost|selected)\b/.test(
      value,
    )
  )
    matchedIntents.push("live_context");
  if (
    /\b(thread|agent|delegat(?:e|ed)|resum(?:e|able)|still running|status|crash(?:ed)?)\b/.test(
      value,
    ) ||
    /\bprogress\b(?!\s+summar(?:y|ies))/i.test(value)
  )
    matchedIntents.push("delegated_work");
  if (
    /\b(what did i|did i|when did|where did|first|earliest|latest|last time|what happened|actually go|actually do|i said|i went|old discussion|past discussion|past conversation|transcript)\b/.test(
      value,
    )
  )
    matchedIntents.push("episodic");
  if (
    /(?:^|\s)(?:\/[^\s]+|[\w.-]+\/[\w./-]+)|\b(repo(?:sitor(?:y|ies))?s?|paths?|files?|prior decisions?|decisions?|polic(?:y|ies)|rules?|established|determine|determined|recall hooks?)\b/.test(
      value,
    )
  )
    matchedIntents.push("durable_memory");

  const exactPhrases = extractExactRecallPhrases(prompt);
  if (matchedIntents.length > 1) {
    return {
      intent: "multi_source",
      matchedIntents,
      deterministicFastPath: false,
      exactPhrases,
    };
  }
  if (matchedIntents.length === 1) {
    const intent = matchedIntents[0]!;
    return {
      intent,
      matchedIntents,
      // Episodic results are timelines, not answers. They require synthesis.
      deterministicFastPath: intent !== "episodic",
      exactPhrases,
    };
  }
  if (isBareRepoLookup(prompt)) {
    return {
      intent: "durable_memory",
      matchedIntents: [],
      deterministicFastPath: true,
      exactPhrases,
    };
  }
  return {
    intent: "multi_source",
    matchedIntents: [],
    deterministicFastPath: exactPhrases.length > 0,
    exactPhrases,
  };
};

export const routeRecallIntent = (prompt: string): RecallIntent =>
  classifyRecallIntent(prompt).intent;
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

export class RecallRetrievalError extends Error {
  override readonly name = "RecallRetrievalError";
}

/**
 * Recall internals go to stderr as JSON lines (the same channel as the
 * working-indicator traces, landing in runtime.log), so a bad answer is
 * reconstructable after the fact: which searches ran, how big each
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

/** Signal-aware backoff sleep; resolves early (without throwing) on abort. */
const sleepForRetry = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n...[truncated]`;

const truncateExact = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= SEED_TRUNCATION_MARKER.length) {
    return SEED_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - SEED_TRUNCATION_MARKER.length)}${SEED_TRUNCATION_MARKER}`;
};

type EagerSeedSection = {
  heading: string;
  intro?: string;
  body: string;
  maxBodyChars: number;
};

/** Deterministic evidence selection that always preserves the lookup tail. */
export const renderCappedRecallSeed = (
  sections: readonly EagerSeedSection[],
  priority: readonly number[],
): string => {
  const emptyBodies = sections.map((section) =>
    [section.heading, ...(section.intro ? [section.intro] : []), ""].join("\n"),
  );
  let remaining = Math.max(
    0,
    EAGER_RECALL_SEED_MAX_CHARS - emptyBodies.join("\n\n").length,
  );
  const bodyBudgets = sections.map(() => 0);
  for (const index of priority) {
    const section = sections[index];
    if (!section || remaining <= 0) continue;
    const budget = Math.min(
      section.body.length,
      section.maxBodyChars,
      remaining,
    );
    bodyBudgets[index] = budget;
    remaining -= budget;
  }
  return sections
    .map((section, index) =>
      [
        section.heading,
        ...(section.intro ? [section.intro] : []),
        truncateExact(section.body, bodyBudgets[index] ?? 0),
      ].join("\n"),
    )
    .join("\n\n");
};

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
    displayPath: "~/.stella/memories/memory_index.md",
    path: path.join(stellaDataDir, "memories", "memory_index.md"),
    includeByDefault: true,
  },
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
      "Full ~/.stella/memories/MEMORY.md omitted because search terms were provided. Use # Memory Search Results for matched lines.",
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
      `[truncated after ${matchCount} matches; narrow or change the search terms for more precise recall]`,
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
 * Live-update lines for one thread: recent assistant text authored by the
 * agent itself and already persisted in its runtime transcript. Only rendered
 * for threads that are ACTIVE right now.
 */
const formatThreadLiveUpdateLines = (
  store: Pick<ContextLookupStore, "listAgentAssistantMessages">,
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
    entries = store.listAgentAssistantMessages(
      thread.threadId,
      MAX_LIVE_AGENT_MESSAGES,
    );
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  return [
    "  agent updates (newest last):",
    ...entries.map(
      (entry) =>
        `    - [${formatClockTime(entry.atMs)}] ${sanitizeToolVisibleText(
          entry.text,
        )}`,
    ),
  ];
};

const formatAbsoluteTimestamp = (timestamp: number): string =>
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

/**
 * The `search_threads` tool (also the pre-seeded "# Agent Thread Search
 * Results" section): a keyword search over EVERY delegated agent thread ever
 * run, across all conversations and any age — this replaces the old inline
 * thread index the seed used to carry wholesale. Relevance (matched-token
 * count in SQL) picks WHICH threads make the page; the page itself renders
 * newest-first by last activity with an absolute date/time per entry, so the
 * model always has recency awareness. Final result/error excerpts come along
 * because `summary` is empty on nearly every real thread.
 */
export const formatThreadSearchResults = (
  store: Pick<
    ContextLookupStore,
    "searchThreads" | "listAgentAssistantMessages" | "listThreadResultExcerpts"
  >,
  conversationId: string,
  query: string | undefined,
  limit?: number,
): string => {
  const cappedLimit = Math.max(
    1,
    Math.min(
      MAX_THREAD_SEARCH_RESULTS,
      Math.floor(limit ?? MAX_THREAD_SEARCH_RESULTS),
    ),
  );
  const trimmedQuery = query?.trim();
  const threads = store.searchThreads({
    conversationId,
    ...(trimmedQuery ? { query: trimmedQuery } : {}),
    limit: cappedLimit,
  });
  if (threads.length === 0) {
    return trimmedQuery
      ? "No agent threads matched. Try fewer/different concrete terms, or omit the query to browse the most recent work."
      : "No past agent work recorded yet.";
  }
  let excerpts: ReturnType<ContextLookupStore["listThreadResultExcerpts"]>;
  try {
    excerpts = store.listThreadResultExcerpts(
      threads.map((thread) => thread.threadId),
    );
  } catch {
    excerpts = new Map();
  }
  const ordered = [...threads].sort(
    (a, b) =>
      runtimeThreadLastActiveAt(b) - runtimeThreadLastActiveAt(a) ||
      a.threadId.localeCompare(b.threadId),
  );
  const rendered = ordered.map((thread) => {
    const sameConversation = thread.conversationId === conversationId;
    const excerpt = excerpts.get(thread.threadId);
    const name = thread.name ? collapseWhitespace(thread.name) : "";
    const lines = [
      `- ${thread.threadId} | last active ${formatAbsoluteTimestamp(
        runtimeThreadLastActiveAt(thread),
      )} (${formatRuntimeThreadStatusSuffix(thread)}) | from ${
        sameConversation ? "this conversation" : "another conversation"
      }${name ? ` | ${sanitizeToolVisibleText(name)}` : ""}`,
    ];
    // Names are minted from descriptions, so most pairs are identical — only
    // render a description that adds information.
    const description = thread.description?.trim()
      ? collapseWhitespace(thread.description)
      : "";
    if (description && description !== name) {
      lines.push(`  description: ${sanitizeToolVisibleText(description)}`);
    }
    const summary = thread.summary?.trim()
      ? collapseWhitespace(thread.summary).slice(0, 300)
      : "";
    if (summary) lines.push(`  summary: ${sanitizeToolVisibleText(summary)}`);
    if (excerpt?.resultExcerpt) {
      lines.push(
        `  result: ${sanitizeToolVisibleText(collapseWhitespace(excerpt.resultExcerpt))}`,
      );
    }
    if (excerpt?.errorExcerpt) {
      lines.push(
        `  error: ${sanitizeToolVisibleText(collapseWhitespace(excerpt.errorExcerpt))}`,
      );
    }
    lines.push(...formatThreadLiveUpdateLines(store, thread));
    return lines.join("\n");
  });
  return ["[newest → oldest by last activity]", ...rendered].join("\n");
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
 * The `search_transcripts` tool (also the pre-seeded "# Transcript Search
 * Results" section): what the user and Stella actually said, across ALL
 * conversations. The store ranks hits by relevance — that ranking decides
 * WHICH hits get their surrounding exchange expanded — but the page renders
 * strictly oldest → newest, because episodic questions are answered by
 * reading the messages as a timeline and models reliably misread
 * "first/last time" from a relevance-shuffled list.
 */
export const formatTranscriptSearchResults = (
  store: Pick<
    ContextLookupStore,
    "searchTranscripts" | "listTranscriptNeighbors"
  >,
  conversationId: string,
  query: string | undefined,
  limit?: number,
  listNeighborsBatch?: (
    targets: readonly { conversationId: string; atMs: number }[],
    options?: { before?: number; after?: number; windowMs?: number },
  ) => TranscriptSearchHit[][],
): string => {
  const cappedLimit = Math.max(1, Math.min(25, Math.floor(limit ?? 12)));
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) {
    return "No usable search terms — pass concrete nouns (names, places, file paths, slugs, error text).";
  }
  const hits = store.searchTranscripts({
    query: query ?? "",
    limit: cappedLimit,
  });
  if (hits.length === 0) {
    return "Nothing matched in past conversation transcripts. Try fewer/different concrete words.";
  }

  // Hits arrive relevance-ranked; relevance decides WHICH hits get their
  // surrounding exchange, but hits inside an already-expanded episode don't
  // burn a second slot.
  const expandable = new Set<TranscriptSearchHit>();
  for (const hit of hits) {
    if (expandable.size >= MESSAGE_CONTEXT_TOP_HITS) break;
    const withinExpandedEpisode = [...expandable].some(
      (other) =>
        other.conversationId === hit.conversationId &&
        Math.abs(other.atMs - hit.atMs) <= MESSAGE_EPISODE_WINDOW_MS,
    );
    if (withinExpandedEpisode) continue;
    expandable.add(hit);
  }

  const expandableHits = [...expandable];
  let batchedNeighbors: TranscriptSearchHit[][] | undefined;
  if (listNeighborsBatch && expandableHits.length > 0) {
    try {
      batchedNeighbors = listNeighborsBatch(
        expandableHits.map((hit) => ({
          conversationId: hit.conversationId,
          atMs: hit.atMs,
        })),
        { before: MESSAGE_CONTEXT_BEFORE, after: MESSAGE_CONTEXT_AFTER },
      );
    } catch {
      batchedNeighbors = undefined;
    }
  }
  const expandableIndex = new Map(
    expandableHits.map((hit, index) => [hit, index] as const),
  );

  // Expand a message hit with the surrounding exchange: the matched message
  // names the thing, but the neighbors are usually the event itself.
  const renderHit = (hit: TranscriptSearchHit): string => {
    const sameConversation = hit.conversationId === conversationId;
    // A short conversation tag (instead of a bare "another conversation")
    // lets the model tell that several hits came from the SAME earlier
    // conversation — that co-location is often the story ("that evening").
    const scope = sameConversation
      ? "this conversation"
      : `conversation …${hit.conversationId.slice(-6)}`;
    const rendered = `- [${formatSnippetDate(hit.atMs)}] ${
      hit.role === "user" ? "User" : "Stella"
    } (${scope}): ${sanitizeToolVisibleText(buildMessageSnippet(hit.text, tokens))}`;
    if (!expandable.has(hit)) return rendered;
    let neighbors: ReturnType<ContextLookupStore["listTranscriptNeighbors"]>;
    try {
      const batchIndex = expandableIndex.get(hit);
      neighbors =
        batchIndex !== undefined && batchedNeighbors
          ? (batchedNeighbors[batchIndex] ?? [])
          : store.listTranscriptNeighbors({
              conversationId: hit.conversationId,
              atMs: hit.atMs,
              before: MESSAGE_CONTEXT_BEFORE,
              after: MESSAGE_CONTEXT_AFTER,
            });
    } catch {
      return rendered;
    }
    if (neighbors.length === 0) return rendered;
    const contextLines = neighbors.map((neighbor) => {
      const collapsed = neighbor.text.replace(/\s+/g, " ").trim();
      const clipped =
        collapsed.length <= MESSAGE_CONTEXT_LINE_CHAR_BUDGET
          ? collapsed
          : `${collapsed.slice(0, MESSAGE_CONTEXT_LINE_CHAR_BUDGET)}…`;
      return `    [${formatSnippetDate(neighbor.atMs)}] ${
        neighbor.role === "user" ? "User" : "Stella"
      }: ${sanitizeToolVisibleText(clipped)}`;
    });
    return [rendered, "  surrounding exchange:", ...contextLines].join("\n");
  };

  const ordered = [...hits].sort((a, b) => a.atMs - b.atMs);
  return [
    "[oldest → newest — read as a timeline]",
    ...ordered.map(renderHit),
  ].join("\n");
};

/**
 * The volatile "# Live Thread Status" tail: only the threads executing a
 * turn right now, with their latest agent-authored assistant messages. Any other
 * thread is paused (idle but resumable).
 */
export const formatLiveThreadStatus = (
  store: Pick<
    ContextLookupStore,
    "listThreadsForRecallIndex" | "listAgentAssistantMessages"
  >,
  now = Date.now(),
): string => {
  const threads = store.listThreadsForRecallIndex({
    limit: LIVE_STATUS_MAX_THREADS,
    activeSinceMs: now - LIVE_STATUS_WINDOW_MS,
  });
  const running = threads.filter(
    (thread) => deriveRuntimeThreadLiveState(thread) === "active",
  );
  if (running.length === 0) {
    return "No agent threads are executing a turn right now; every past thread is paused (idle but resumable).";
  }
  return running
    .map((thread) =>
      [
        `- ${thread.threadId} (${formatRuntimeThreadStatusSuffix(thread, now)})`,
        ...formatThreadLiveUpdateLines(store, thread),
      ].join("\n"),
    )
    .join("\n");
};

export const buildContextLookupUserPrompt = async (args: {
  conversationId: string;
  lookupPrompt: string;
  /**
   * Grep-like terms that PRE-SEED the memory, agent-thread, and transcript
   * searches — the recall agent wakes up with its first search round already
   * done. The `Recall` tool requires these; `runRecall` falls back to
   * tokenizing the lookup prompt when a caller omits them.
   */
  searchTerms: readonly string[];
  stellaDataDir: string;
  store: ContextLookupStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
  telemetry?: RecallTelemetryCollector;
}): Promise<string> => {
  const timeSource = async (
    name: string,
    kind: RecallTelemetrySourceKind,
    read: () => Promise<string> | string,
  ): Promise<string> => {
    const startedAt = performance.now();
    let value = "";
    try {
      value = await read();
      return value;
    } finally {
      args.telemetry?.addSource(
        name,
        kind,
        performance.now() - startedAt,
        value.length,
      );
    }
  };
  const terms = normalizeMemorySearchTerms(args.searchTerms);
  const hasTerms = terms.length > 0;
  const seedQuery = terms.join(" ");
  const seedSearchStartedAt = performance.now();
  const [memoryFiles, memorySearchResults, chronicleFiles] = await Promise.all([
    timeSource("seed.memoryFiles", "file", () =>
      readMemoryFiles(args.stellaDataDir, { hasSearchTerms: hasTerms }),
    ),
    hasTerms
      ? timeSource("seed.memorySearch", "file", () =>
          readMemorySearchResults(args.stellaDataDir, terms),
        )
      : timeSource("seed.memorySearch", "file", () =>
          Promise.resolve(
            "No search terms provided — the memory ledger above is the memory evidence; use search_memory for targeted lines.",
          ),
        ),
    timeSource("seed.chronicleFiles", "file", () =>
      readChronicleFiles(args.stellaDataDir),
    ),
  ]);
  const threadSearchResults = await timeSource("seed.threadSearch", "sql", () =>
    formatThreadSearchResults(
      args.store,
      args.conversationId,
      hasTerms ? seedQuery : undefined,
    ),
  );
  const transcriptSearchResults = hasTerms
    ? await timeSource("seed.transcriptSearch", "sql", () =>
        formatTranscriptSearchResults(
          args.store,
          args.conversationId,
          seedQuery,
        ),
      )
    : "No search terms provided — use search_transcripts with concrete terms.";
  const liveStatus = await timeSource("seed.liveThreadStatus", "sql", () =>
    formatLiveThreadStatus(args.store),
  );
  args.telemetry?.setSeedSearchMs(performance.now() - seedSearchStartedAt);

  // Pre-seeded searches lead (they are the likeliest evidence), live/current
  // state follows, and the lookup request comes LAST so it sits closest to
  // the model's answer.
  const assemblyStartedAt = performance.now();
  const sections: EagerSeedSection[] = [
    {
      heading: "# Memory Files",
      body: memoryFiles,
      maxBodyChars: 600,
    },
    {
      heading: "# Memory Search Results",
      intro: "Pre-run from the lookup's search terms.",
      body: memorySearchResults,
      maxBodyChars: 1_700,
    },
    {
      heading: "# Agent Thread Search Results",
      intro: `Pre-run from the lookup's search terms: delegated agent threads matching them (across ALL conversations, any age; up to ${MAX_THREAD_SEARCH_RESULTS}, newest first by last activity). Each entry: thread_id | last active date/time | live state, plus name/description/summary and final result/error excerpts. This is a NARROWED view — threads that don't match the terms are not listed; find those with search_threads.`,
      body: threadSearchResults,
      maxBodyChars: 2_300,
    },
    {
      heading: "# Transcript Search Results",
      intro:
        "Pre-run from the lookup's search terms: past chat messages matching them (across ALL conversations), oldest → newest.",
      body: transcriptSearchResults,
      maxBodyChars: 2_700,
    },
    {
      heading: "# Current Time",
      body: formatDateTimeReminder(Date.now()),
      maxBodyChars: 300,
    },
    {
      heading: "# Local App And Browser Context",
      body: formatLiveAppBrowserContext(args.appBrowserContext),
      maxBodyChars: 350,
    },
    {
      heading: "# Message-Attached App And Browser Context",
      body: formatLatestLocalContext(args.localEvents),
      maxBodyChars: 350,
    },
    {
      heading: "# Live Thread Status",
      intro:
        "Threads executing a turn RIGHT NOW, with their latest agent-authored assistant messages. Any other thread is paused (idle but resumable) as of the current time above.",
      body: liveStatus,
      maxBodyChars: 750,
    },
    {
      heading: "# Chronicle Context",
      body: chronicleFiles,
      maxBodyChars: 350,
    },
    {
      heading: "# Lookup Request",
      body: args.lookupPrompt.trim(),
      maxBodyChars: 1_000,
    },
  ];
  // Search evidence first, then the request and live status; lower-signal
  // context fills only the remaining deterministic budget.
  const prompt = renderCappedRecallSeed(
    sections,
    [1, 2, 3, 9, 7, 0, 4, 5, 6, 8],
  );
  args.telemetry?.addAssemblyMs(performance.now() - assemblyStartedAt);
  return prompt;
};

type RecallSearchAction =
  | { kind: "search_memory"; terms: string[] }
  | { kind: "search_transcripts"; query?: string; limit?: number }
  | { kind: "search_threads"; query?: string; limit?: number };

/**
 * Map a tool call onto a search action. Legacy names from older transcripts
 * ("search", "search_messages", "search_agents") resolve to the nearest
 * current tool instead of erroring — models occasionally echo tool names
 * they saw before the split.
 */
export const resolveRecallSearchAction = (
  toolName: string,
  toolArgs: Record<string, unknown>,
): RecallSearchAction | null => {
  const name = toolName.trim().toLocaleLowerCase();
  if (name === "search_memory") {
    const terms = Array.isArray(toolArgs.terms)
      ? toolArgs.terms.filter(
          (term): term is string => typeof term === "string",
        )
      : [];
    return { kind: "search_memory", terms };
  }
  const query = typeof toolArgs.query === "string" ? toolArgs.query : undefined;
  const limit = typeof toolArgs.limit === "number" ? toolArgs.limit : undefined;
  if (
    name === "search_transcripts" ||
    name === "search" ||
    name === "search_messages"
  ) {
    return {
      kind: "search_transcripts",
      ...(query !== undefined ? { query } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  if (name === "search_threads" || name === "search_agents") {
    return {
      kind: "search_threads",
      ...(query !== undefined ? { query } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  return null;
};

type RecallSourceReference = {
  kind: "memory" | "thread" | "transcript" | "live";
  inboxId?: number;
  threadId?: string;
  runId?: string;
};

type RecallReadQueries = {
  getFtsHealth: () => {
    healthy: boolean;
    transcriptReady: boolean;
    threadsReady: boolean;
    reason?: string;
  };
  listTranscriptNeighborsBatch: (
    targets: readonly { conversationId: string; atMs: number }[],
    options?: { before?: number; after?: number; windowMs?: number },
  ) => TranscriptSearchHit[][];
};

const splitRecallEvidenceUnits = (
  kind: RecallIntent,
  value: string,
): string[] => {
  if (kind === "durable_memory") {
    const matches = value.match(/<match\b[^>]*>[\s\S]*?<\/match>/g) ?? [];
    return matches.flatMap((match) => {
      const lines = match.split("\n");
      const opening = lines[0] ?? "<match>";
      const body = lines.slice(1, -1);
      const groups: string[][] = [];
      for (const line of body) {
        if (/^\d+:\s+(?:- |##\s)/.test(line) || groups.length === 0) {
          groups.push([line]);
        } else {
          groups[groups.length - 1]!.push(line);
        }
      }
      return groups
        .filter((group) => group.some((line) => line.trim()))
        .map((group) => [opening, ...group, "</match>"].join("\n"));
    });
  }
  const pattern =
    kind === "delegated_work"
      ? /^- [^\n]+[\s\S]*?(?=^- |^# Live status|(?![\s\S]))/gm
      : kind === "episodic"
        ? /^- \[[^\n]+\][\s\S]*?(?=^- \[|(?![\s\S]))/gm
        : /^- [\s\S]*?(?=^- |(?![\s\S]))/gm;
  const units = value
    .match(pattern)
    ?.map((unit) => unit.trim())
    .filter(Boolean);
  return units?.length ? units : [value.trim()].filter(Boolean);
};

const selectUsableRecallEvidence = (
  kind: RecallIntent,
  value: string,
  terms: readonly string[],
  exactPhrases: readonly string[],
): string | null => {
  const normalized = value.toLocaleLowerCase();
  if (
    kind === "durable_memory" &&
    normalized.includes("no matching memory lines found")
  ) {
    return null;
  }
  if (
    kind === "delegated_work" &&
    (normalized.includes("no agent threads matched") ||
      normalized.includes("no past agent work recorded")) &&
    normalized.includes("no agent threads are executing a turn right now")
  ) {
    return null;
  }
  if (
    kind === "episodic" &&
    (normalized.includes("nothing matched in past conversation") ||
      normalized.includes("no usable search terms"))
  ) {
    return null;
  }
  if (
    kind === "live_context" &&
    normalized.includes("no live app or browser-tab snapshot") &&
    normalized.includes("no message-attached app/browser context")
  ) {
    return null;
  }
  const genericTokens = new Set([
    "stella",
    "recall",
    "project",
    "prior",
    "decision",
  ]);
  const distinctiveTermGroups = terms.flatMap((term) => {
    const tokens = [
      ...new Set(
        tokenizeSearchQuery(term)
          .map((token) => token.toLocaleLowerCase())
          .filter((token) => token.length >= 4 && !genericTokens.has(token)),
      ),
    ];
    return tokens.length > 0 ? [tokens] : [];
  });
  const normalizedExactPhrases = exactPhrases.map((phrase) =>
    phrase.replace(/\s+/g, " ").trim().toLocaleLowerCase(),
  );
  const requiredGroupMatches =
    normalizedExactPhrases.length > 0 ? 0 : distinctiveTermGroups.length;
  if (requiredGroupMatches === 0 && normalizedExactPhrases.length === 0)
    return null;
  const matchingUnits = splitRecallEvidenceUnits(kind, value).filter((unit) => {
    const normalizedUnit = unit.replace(/\s+/g, " ").toLocaleLowerCase();
    const anchorText =
      kind === "delegated_work"
        ? (unit.split("\n", 1)[0] ?? "").toLocaleLowerCase()
        : normalizedUnit;
    if (
      normalizedExactPhrases.length > 0 &&
      !normalizedExactPhrases.every((phrase) => normalizedUnit.includes(phrase))
    ) {
      return false;
    }
    return (
      distinctiveTermGroups.filter((group) =>
        group.every((token) => anchorText.includes(token)),
      ).length >= requiredGroupMatches
    );
  });
  return matchingUnits.length > 0 ? matchingUnits.join("\n\n") : null;
};

const hasSubstantiveRecallEvidence = (value: string): boolean =>
  value.split("\n").some((line) => {
    const normalized = line.trim();
    if (!normalized || normalized.startsWith("#")) return false;
    return !/^(?:nothing relevant found|no\b.*\b(?:found|available|matched|matches|results?))\.?$/i.test(
      normalized,
    );
  });

const deterministicReformulation = (
  prompt: string,
  originalTerms: readonly string[],
): string[] => {
  const filler = new Set([
    "what",
    "when",
    "where",
    "which",
    "did",
    "does",
    "have",
    "about",
    "prior",
    "previous",
    "find",
    "recall",
    "status",
    "first",
    "last",
    "latest",
  ]);
  const original = new Set(
    originalTerms.flatMap((term) => tokenizeSearchQuery(term)),
  );
  const candidates = tokenizeSearchQuery(prompt)
    .map((term) =>
      term
        .replace(/^["'“”([{]+/g, "")
        .replace(/["'“”),;:!?]+$/g, "")
        .replace(/\.$/g, ""),
    )
    .filter((term) => term.length >= 3 && !filler.has(term.toLocaleLowerCase()))
    .filter((term) => !original.has(term));
  return normalizeMemorySearchTerms(
    candidates.length > 0
      ? candidates
      : originalTerms.flatMap((term) => term.split(/[^\p{L}\p{N}_.\/-]+/u)),
  );
};

const runArchitecturalRecall = async (args: {
  conversationId: string;
  lookupPrompt: string;
  seedTerms: readonly string[];
  stellaAppDir: string;
  stellaDataDir: string;
  store: RuntimeStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
  recallRoute: RecallModelRoute;
  recallReadQueries?: RecallReadQueries;
  telemetry: RecallTelemetryCollector;
  emitTelemetry: (outcome: string) => void;
  onResultMetadata?: (metadata: {
    intent: RecallIntent;
    fastPath: boolean;
    sources: RecallSourceReference[];
  }) => void;
  signal?: AbortSignal;
}): Promise<string> => {
  const intentDecision = classifyRecallIntent(args.lookupPrompt);
  const intent = intentDecision.intent;
  const classificationRequiresSynthesis =
    !intentDecision.deterministicFastPath;
  let synthesisRequired = classificationRequiresSynthesis;
  args.telemetry.setIntent(intent, intentDecision.deterministicFastPath);
  const useClaudeCode = args.recallRoute.executionEngine === "claude-code";
  args.telemetry.setRoute(
    useClaudeCode ? "claude-code" : "native",
    args.recallRoute.modelId,
  );

  let sourceKinds:
    | readonly ["durable_memory"]
    | readonly ["delegated_work"]
    | readonly ["episodic"]
    | readonly ["live_context"]
    | readonly ["durable_memory", "delegated_work", "episodic"] =
    intent === "durable_memory"
      ? (["durable_memory"] as const)
      : intent === "delegated_work"
        ? (["delegated_work"] as const)
        : intent === "episodic"
          ? (["episodic"] as const)
          : intent === "live_context"
            ? (["live_context"] as const)
            : (["durable_memory", "delegated_work", "episodic"] as const);

  let ftsChecked = false;
  const ensureFtsReady = (): void => {
    if (ftsChecked || !args.recallReadQueries) return;
    if (
      !sourceKinds.some(
        (kind) => kind === "delegated_work" || kind === "episodic",
      )
    ) {
      return;
    }
    ftsChecked = true;
    const healthStartedAt = performance.now();
    const health = args.recallReadQueries.getFtsHealth();
    args.telemetry.addSource(
      "retrieval.ftsHealth",
      "sql",
      performance.now() - healthStartedAt,
    );
    const needsTranscriptFts = sourceKinds.some((kind) => kind === "episodic");
    const needsThreadFts = sourceKinds.some(
      (kind) => kind === "delegated_work",
    );
    const requiredIndexesReady =
      (!needsTranscriptFts || health.transcriptReady) &&
      (!needsThreadFts || health.threadsReady);
    if (!requiredIndexesReady) {
      const diagnostic = {
        conversationId: args.conversationId,
        transcriptReady: health.transcriptReady,
        threadsReady: health.threadsReady,
        reason: health.reason ?? "unknown",
      };
      console.error("[stella:recall:fts-degraded]", JSON.stringify(diagnostic));
      throw new RecallRetrievalError(
        `Recall FTS unavailable: ${health.reason ?? "index health check failed"}`,
      );
    }
  };
  ensureFtsReady();

  const retrieve = async (terms: readonly string[]) => {
    args.telemetry.addRetrievalPass();
    const query = normalizeMemorySearchTerms(terms).join(" ");
    const passStartedAt = performance.now();
    const results = await Promise.all(
      sourceKinds.map(async (kind) => {
        const startedAt = performance.now();
        let value = "";
        try {
          if (kind === "durable_memory") {
            value = await readMemorySearchResults(args.stellaDataDir, terms);
          } else if (kind === "delegated_work") {
            const threads = formatThreadSearchResults(
              args.store,
              args.conversationId,
              query,
            );
            const live = formatLiveThreadStatus(args.store);
            value = `${threads}\n\n# Live status\n${live}`;
          } else if (kind === "episodic") {
            value = formatTranscriptSearchResults(
              args.store,
              args.conversationId,
              query,
              undefined,
              args.recallReadQueries?.listTranscriptNeighborsBatch,
            );
          } else {
            value = [
              formatLiveAppBrowserContext(args.appBrowserContext),
              formatLatestLocalContext(args.localEvents),
            ].join("\n\n");
          }
          return { kind, value };
        } catch (error) {
          throw error instanceof RecallRetrievalError
            ? error
            : new RecallRetrievalError(
                `Recall ${kind} retrieval failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { cause: error },
              );
        } finally {
          args.telemetry.addSource(
            `retrieval.${kind}`,
            kind === "durable_memory"
              ? "file"
              : kind === "live_context"
                ? "host"
                : "sql",
            performance.now() - startedAt,
            value.length,
          );
        }
      }),
    );
    args.telemetry.setSeedSearchMs(performance.now() - passStartedAt);
    return results;
  };

  const selectUsableEvidence = (
    evidence: Array<{ kind: RecallIntent; value: string }>,
    terms: readonly string[],
  ): Array<{ kind: RecallIntent; value: string }> =>
    evidence.flatMap(({ kind, value }) => {
      const selected = selectUsableRecallEvidence(
        kind,
        value,
        terms,
        intentDecision.exactPhrases,
      );
      return selected ? [{ kind, value: selected }] : [];
    });

  let evidenceTerms = args.seedTerms;
  let evidence = await retrieve(evidenceTerms);
  let usable = selectUsableEvidence(evidence, evidenceTerms);
  if (usable.length === 0 && classificationRequiresSynthesis) {
    // Ambiguous and episodic requests are deliberately model-routed. Their
    // evidence may be individually incomplete; that is exactly why synthesis
    // is required. Do not turn the direct-answer confidence gate into an
    // accidental no-match gate for those requests.
    usable = evidence.filter(({ value }) =>
      hasSubstantiveRecallEvidence(value),
    );
  }
  if (usable.length === 0) {
    if (intent === "durable_memory") {
      // A durable-index miss gets one transcript pass with the SAME concrete
      // anchors. Broadening file terms creates false positives (for example,
      // matching the generic word "project" in an unrelated memory block).
      sourceKinds = ["episodic"];
      // Transcript rows are timelines, not direct answers. A durable-memory
      // miss may consult them, but only an explicit exact-phrase lookup can
      // return a matched row without synthesis.
      if (intentDecision.exactPhrases.length === 0) synthesisRequired = true;
      ensureFtsReady();
      evidence = await retrieve(evidenceTerms);
    } else {
      const reformulated = deterministicReformulation(
        args.lookupPrompt,
        args.seedTerms,
      );
      if (reformulated.length > 0) {
        evidenceTerms = reformulated;
        evidence = await retrieve(evidenceTerms);
      }
    }
    usable = selectUsableEvidence(evidence, evidenceTerms);
    if (usable.length === 0 && classificationRequiresSynthesis) {
      usable = evidence.filter(({ value }) =>
        hasSubstantiveRecallEvidence(value),
      );
    }
  }

  if (usable.length === 0) {
    args.telemetry.setSeedChars(0);
    args.onResultMetadata?.({ intent, fastPath: true, sources: [] });
    args.emitTelemetry("no-match");
    return RECALL_NO_MATCH_TEXT;
  }

  const assemblyStartedAt = performance.now();
  const evidenceText = renderCappedRecallSeed(
    usable.map(({ kind, value }) => ({
      heading: `# ${kind.replaceAll("_", " ")}`,
      body: value,
      maxBodyChars: 8_500,
    })),
    usable.map((_, index) => index),
  );
  args.telemetry.setSeedChars(evidenceText.length);
  args.telemetry.addAssemblyMs(performance.now() - assemblyStartedAt);

  const threadIds = new Set<string>();
  for (const match of evidenceText.matchAll(/^- ([^\s|]+) \|/gm)) {
    if (match[1]) threadIds.add(match[1]);
  }
  const sources: RecallSourceReference[] = usable.map(({ kind }) => ({
    kind:
      kind === "durable_memory"
        ? "memory"
        : kind === "delegated_work"
          ? "thread"
          : kind === "episodic"
            ? "transcript"
            : "live",
  }));
  if (threadIds.size > 0) {
    const rows = args.store.dreamInboxStore.findThreadSummariesByThreadIds([
      ...threadIds,
    ]);
    for (const row of rows) {
      if (!row.threadId || !row.runId || !threadIds.has(row.threadId)) continue;
      try {
        args.store.dreamInboxStore.recordUsage(row.threadId, row.runId);
      } catch (error) {
        // Read-only benchmark snapshots cannot persist feedback. Production
        // writes remain best-effort bookkeeping, never a Recall failure.
        logRecallTrace("[stella:recall:usage-feedback-failed]", {
          threadId: row.threadId,
          runId: row.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      sources.push({
        kind: "thread",
        inboxId: row.id,
        threadId: row.threadId,
        runId: row.runId,
      });
      threadIds.delete(row.threadId);
    }
  }

  if (!synthesisRequired) {
    args.onResultMetadata?.({ intent, fastPath: true, sources });
    args.emitTelemetry("fast-path");
    return evidenceText;
  }

  args.telemetry.setIntent(intent, false);
  const systemPrompt =
    "Synthesize the supplied Recall evidence into one concise factual brief. Cite dates and thread ids present in evidence. Do not invent facts. If evidence is insufficient, answer exactly: Nothing relevant found.";
  const userPrompt = `${evidenceText}\n\n# Lookup request\n${args.lookupPrompt.trim()}`;
  const modelStartedAt = performance.now();
  let brief = "";
  try {
    if (useClaudeCode) {
      brief = (
        await runClaudeCodeAgentTextCompletion({
          stellaAppDir: args.stellaDataDir,
          cwd: args.stellaAppDir,
          agentType: AGENT_IDS.ORCHESTRATOR,
          modelOverride: args.recallRoute.claudeCodeModel,
          effortLevel: "low",
          context: {
            systemPrompt,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: userPrompt }],
                timestamp: Date.now(),
              },
            ],
            tools: [],
          },
          abortSignal: args.signal,
        })
      ).trim();
    } else {
      const resolvedLlm = args.recallRoute.resolvedLlm;
      if (!resolvedLlm) {
        throw new Error("Recall light-tier route is unavailable.");
      }
      const apiKey = (await resolvedLlm.getApiKey())?.trim();
      if (!apiKey) throw new Error("No Recall model credential is configured.");
      const response = await completeSimple(
        resolvedLlm.model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: userPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          reasoning: "low",
          ...(resolvedLlm.refreshApiKey
            ? { refreshApiKey: resolvedLlm.refreshApiKey }
            : {}),
          maxTokens: MAX_CONTEXT_OUTPUT_TOKENS,
          temperature: 0,
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted"
      ) {
        throw new Error(response.errorMessage ?? response.stopReason);
      }
      brief = readAssistantText(response).trim();
    }
  } finally {
    args.telemetry.addModelCall(performance.now() - modelStartedAt);
  }
  args.onResultMetadata?.({ intent, fastPath: false, sources });
  args.emitTelemetry(brief ? "answer" : "empty-brief");
  return brief || RECALL_EMPTY_BRIEF_TEXT;
};

/**
 * Agent-backed recall. Seeds the model with the eager context (memory
 * summary, pre-seeded memory/thread/transcript search results from the
 * lookup's search terms, live app/browser state, recent activity, live
 * thread status, chronicle), then runs a bounded NATIVE tool-call loop —
 * the model reformulates searches over the deep memory ledger, every past
 * delegated agent thread, and past chat transcripts, calling several tools
 * in parallel per round — before answering with a plain-text brief. Runs
 * synchronously as the `Recall` tool's backing.
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
  recallRoute: RecallModelRoute;
  recallReadQueries?: RecallReadQueries;
  telemetry?: RecallTelemetrySeed;
  onTelemetry?: (record: RecallTelemetryRecord) => void;
  onResultMetadata?: (metadata: {
    intent: RecallIntent;
    fastPath: boolean;
    sources: RecallSourceReference[];
  }) => void;
  signal?: AbortSignal;
}): Promise<string> => {
  const telemetry = new RecallTelemetryCollector(args.telemetry);
  let telemetryEmitted = false;
  const emitTelemetry = (outcome: string): void => {
    if (telemetryEmitted) return;
    telemetryEmitted = true;
    const record = telemetry.snapshot(args.conversationId, outcome);
    logRecallTrace("[stella:recall:telemetry]", record);
    try {
      args.onTelemetry?.(record);
    } catch {
      // Observers are diagnostic-only and must never break Recall.
    }
  };

  // The Recall tool requires search terms; for callers that still omit
  // them, tokenizing the lookup prompt keeps the pre-seed useful.
  const seedTerms = normalizeMemorySearchTerms(
    args.memorySearchTerms?.length
      ? args.memorySearchTerms
      : tokenizeSearchQuery(args.lookupPrompt),
  );
  if (args.recallReadQueries) {
    try {
      return await runArchitecturalRecall({
        conversationId: args.conversationId,
        lookupPrompt: args.lookupPrompt,
        seedTerms,
        stellaAppDir: args.stellaAppDir,
        stellaDataDir: args.stellaDataDir,
        store: args.store,
        localEvents: args.localEvents,
        ...(args.appBrowserContext
          ? { appBrowserContext: args.appBrowserContext }
          : {}),
        recallRoute: args.recallRoute,
        ...(args.recallReadQueries
          ? { recallReadQueries: args.recallReadQueries }
          : {}),
        telemetry,
        emitTelemetry,
        ...(args.onResultMetadata
          ? { onResultMetadata: args.onResultMetadata }
          : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (error) {
      emitTelemetry("thrown");
      throw error instanceof RecallRetrievalError
        ? error
        : new Error(error instanceof Error ? error.message : String(error));
    }
  }

  // Test/replay callers without the read-query bundle retain the previous
  // implementation while production always supplies the architectural path.
  let seed: string;
  try {
    seed = await buildContextLookupUserPrompt({
      conversationId: args.conversationId,
      lookupPrompt: args.lookupPrompt,
      searchTerms: seedTerms,
      stellaDataDir: args.stellaDataDir,
      store: args.store,
      localEvents: args.localEvents,
      ...(args.appBrowserContext
        ? { appBrowserContext: args.appBrowserContext }
        : {}),
      telemetry,
    });
  } catch (error) {
    emitTelemetry("thrown");
    throw new RecallRetrievalError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  telemetry.setSeedChars(seed.length);

  // The runner resolves this authoritative route from the active engine before
  // retrieval. Claude needs no provider credential here; its explicit Haiku
  // override is carried separately from saved user model preferences.
  const useClaudeCode = args.recallRoute.executionEngine === "claude-code";
  telemetry.setRoute(
    useClaudeCode ? "claude-code" : "native",
    args.recallRoute.modelId,
  );
  const verbose = recallTraceVerbose();
  const finish = (outcome: string, brief: string): string => {
    logRecallTrace("[stella:recall:answer]", {
      conversationId: args.conversationId,
      outcome,
      briefChars: brief.length,
      ...(verbose ? { briefPreview: previewForTrace(brief) } : {}),
    });
    emitTelemetry(outcome);
    return brief;
  };
  const resolvedLlm = args.recallRoute.resolvedLlm;
  if (!useClaudeCode && !resolvedLlm) {
    return finish(
      "route-unavailable",
      "Recall failed: the active engine's light-tier route is unavailable.",
    );
  }
  const apiKey = useClaudeCode
    ? undefined
    : (await resolvedLlm?.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    return finish(
      "credential-unavailable",
      "Recall is unavailable because no model credential is configured.",
    );
  }

  /** Model-INITIATED searches only — the pre-seeded seed round doesn't count. */
  let ranSearch = false;
  let searchStep = 0;

  const executeSearchAction = async (
    action: RecallSearchAction,
  ): Promise<string> => {
    ranSearch = true;
    const sourceStartedAt = performance.now();
    let observation = "";
    try {
      observation =
        action.kind === "search_memory"
          ? await readMemorySearchResults(args.stellaDataDir, action.terms)
          : action.kind === "search_transcripts"
            ? formatTranscriptSearchResults(
                args.store,
                args.conversationId,
                action.query,
                action.limit,
              )
            : formatThreadSearchResults(
                args.store,
                args.conversationId,
                action.query,
                action.limit,
              );
    } finally {
      telemetry.addSource(
        `tool.${action.kind === "search_memory" ? "memorySearch" : action.kind === "search_transcripts" ? "transcriptSearch" : "threadSearch"}`,
        action.kind === "search_memory" ? "file" : "sql",
        performance.now() - sourceStartedAt,
        observation.length,
      );
    }
    logRecallTrace("[stella:recall:step]", {
      conversationId: args.conversationId,
      step: searchStep++,
      action: action.kind,
      observationChars: observation.length,
      // Search terms/queries and observation content are user data — only
      // traced when explicitly debugging.
      ...(verbose
        ? {
            actionDetail:
              action.kind === "search_memory"
                ? { terms: action.terms }
                : { query: action.query ?? null },
            observationPreview: previewForTrace(observation),
          }
        : {}),
    });
    return truncate(observation, RECALL_OBSERVATION_CHAR_BUDGET);
  };

  /** One tool call → one search, shared by both engines' tool protocols. */
  const executeRecallToolCall = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: string }> => {
    const action = resolveRecallSearchAction(toolName, toolArgs);
    if (!action) {
      return {
        error: `Unknown tool "${toolName}". Use search_memory, search_transcripts, or search_threads, or reply with the final brief as plain text.`,
      };
    }
    try {
      return { result: await executeSearchAction(action) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Search failed: ${message}` };
    }
  };

  logRecallTrace("[stella:recall:start]", {
    conversationId: args.conversationId,
    promptChars: args.lookupPrompt.length,
    seedChars: seed.length,
    seedTermCount: seedTerms.length,
    ...(verbose
      ? { promptPreview: previewForTrace(args.lookupPrompt, 200) }
      : {}),
  });

  const runModelCall = async <T>(call: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    let failed = false;
    try {
      return await call();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      telemetry.addModelCall(performance.now() - startedAt);
      if (failed) emitTelemetry("thrown");
    }
  };

  const userMessage = (text: string): Message => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

  // A nothing-found verdict without a single model-initiated search behind
  // it is the exact failure mode observed in the field (the model glancing
  // past the pre-seeded context and giving up) — reject it ONCE and demand
  // a reformulated search.
  const rejectionText = (searchHint: string): string =>
    `Rejected: you answered "Nothing relevant found." without running a single search of your own. The pre-seeded results are ONE keyword angle, not proof of absence — re-scan the pre-seeded sections for candidates, then run ${searchHint} with DIFFERENT concrete terms from the lookup request (names, slugs, file paths — not status words) before concluding nothing exists.`;

  if (useClaudeCode) {
    // The engine loops over tool calls internally within one completion; the
    // outer loop exists only for the one-time nothing-found rejection.
    const messages: Message[] = [userMessage(seed)];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context: Context = {
        systemPrompt: RECALL_TOOL_RUNTIME_SYSTEM_PROMPT,
        tools: RECALL_RUNTIME_TOOLS,
        messages,
      };
      let observedModelRounds = 0;
      const observedModelRoundIds = new Set<string>();
      const observedToolRoundIds = new Set<string>();
      let anonymousModelRound = 0;
      let activeToolExecutions = 0;
      let toolExecutionStartedAt = 0;
      let toolExecutionMs = 0;
      const beginToolExecution = (): void => {
        if (activeToolExecutions === 0) {
          toolExecutionStartedAt = performance.now();
        }
        activeToolExecutions += 1;
      };
      const endToolExecution = (): void => {
        activeToolExecutions = Math.max(0, activeToolExecutions - 1);
        if (activeToolExecutions === 0) {
          toolExecutionMs += performance.now() - toolExecutionStartedAt;
        }
      };
      const modelStartedAt = performance.now();
      let modelFailed = false;
      let text: string;
      try {
        text = (
          await runClaudeCodeAgentTextCompletion({
            // Preferences always resolve from the data dir; the explicit
            // model pin below makes Recall immune to saved fable/opus picks.
            stellaAppDir: args.stellaDataDir,
            cwd: args.stellaAppDir,
            agentType: AGENT_IDS.ORCHESTRATOR,
            modelOverride: args.recallRoute.claudeCodeModel,
            effortLevel: "low",
            context,
            abortSignal: args.signal,
            onModelRound: ({ messageId, toolCallCount }) => {
              const roundId = messageId ?? `anonymous:${anonymousModelRound++}`;
              if (!observedModelRoundIds.has(roundId)) {
                observedModelRoundIds.add(roundId);
                observedModelRounds += 1;
                telemetry.addModelCall();
              }
              if (toolCallCount > 0 && !observedToolRoundIds.has(roundId)) {
                observedToolRoundIds.add(roundId);
                telemetry.addToolRound();
              }
            },
            executeTool: async (_toolCallId, toolName, toolArgs) => {
              beginToolExecution();
              try {
                return await executeRecallToolCall(toolName, toolArgs);
              } finally {
                endToolExecution();
              }
            },
          })
        ).trim();
      } catch (error) {
        modelFailed = true;
        throw error;
      } finally {
        if (activeToolExecutions > 0) {
          toolExecutionMs += performance.now() - toolExecutionStartedAt;
          activeToolExecutions = 0;
        }
        telemetry.addModelRuntimeMs(
          Math.max(0, performance.now() - modelStartedAt - toolExecutionMs),
        );
        // A launch/transport failure can happen before an assistant event.
        // Preserve one attempted model call instead of reporting zero.
        if (modelFailed || observedModelRounds === 0) telemetry.addModelCall();
        if (modelFailed) emitTelemetry("thrown");
      }
      if (attempt === 0 && text && isRecallNoMatchBrief(text) && !ranSearch) {
        logRecallTrace("[stella:recall:step]", {
          conversationId: args.conversationId,
          step: searchStep,
          action: "answer-rejected",
          reason: "nothing-found-without-search",
        });
        messages.push(
          userMessage(
            `Your previous reply was: ${JSON.stringify(previewForTrace(text))}\n\n${rejectionText(
              "the search_transcripts/search_threads/search_memory tools",
            )}`,
          ),
        );
        continue;
      }
      return finish(
        text ? "answer" : "no-output",
        text || RECALL_NO_OUTPUT_TEXT,
      );
    }
    return finish("no-output", RECALL_NO_OUTPUT_TEXT);
  }

  // Native tool-call loop. History accumulates as real assistant/toolResult
  // turns (never a re-stuffed mega-prompt), so the provider's prompt cache
  // covers the seed and every earlier round on each subsequent step.
  const messages: Message[] = [userMessage(seed)];
  const complete = async (): Promise<AssistantMessage> =>
    runModelCall(() =>
      completeSimple(
        resolvedLlm!.model,
        {
          systemPrompt: RECALL_SYSTEM_PROMPT,
          tools: RECALL_RUNTIME_TOOLS,
          messages,
        },
        {
          apiKey: apiKey as string,
          reasoning: "low",
          ...(resolvedLlm!.refreshApiKey
            ? { refreshApiKey: resolvedLlm!.refreshApiKey }
            : {}),
          maxTokens: MAX_CONTEXT_OUTPUT_TOKENS,
          temperature: 0,
          ...(args.signal ? { signal: args.signal } : {}),
        },
      ),
    );

  // Transport failures (the relay dropping a stream) surface as stopReason
  // "error"; retry those a bounded number of times before failing the
  // lookup. "aborted" is the caller's own signal and is never retried.
  const completeWithRetry = async (): Promise<AssistantMessage> => {
    let response = await complete();
    for (
      let attempt = 1;
      response.stopReason === "error" &&
      attempt <= MAX_RECALL_MODEL_ERROR_RETRIES &&
      !args.signal?.aborted;
      attempt += 1
    ) {
      logRecallTrace("[stella:recall:step]", {
        conversationId: args.conversationId,
        step: searchStep,
        action: "model-error-retry",
        attempt,
        ...(response.errorMessage
          ? { error: previewForTrace(response.errorMessage, 200) }
          : {}),
      });
      await sleepForRetry(
        RECALL_MODEL_ERROR_RETRY_BASE_DELAY_MS * attempt,
        args.signal,
      );
      if (args.signal?.aborted) break;
      response = await complete();
    }
    return response;
  };

  let toolRounds = 0;
  let rejectedNothingFound = false;
  // Terminates: every iteration either returns, spends a tool round
  // (bounded by MAX_RECALL_STEPS then force-answered), or fires the
  // one-time rejection.
  for (;;) {
    const response = await completeWithRetry();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      logRecallTrace("[stella:recall:step]", {
        conversationId: args.conversationId,
        step: searchStep,
        action: "model-error",
        stopReason: response.stopReason,
        // The transport/provider error is structural diagnostics, not user
        // content — always trace it, or a run of failures is undiagnosable
        // from runtime.log (the exact gap that hid the July 2026 relay
        // outage behind a generic "no usable output").
        ...(response.errorMessage
          ? { error: previewForTrace(response.errorMessage, 200) }
          : {}),
      });
      return finish("model-error", RECALL_NO_OUTPUT_TEXT);
    }
    const toolCalls = response.content.filter(
      (part): part is ToolCall => part.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      const brief = readAssistantText(response).trim();
      if (
        brief &&
        isRecallNoMatchBrief(brief) &&
        !ranSearch &&
        !rejectedNothingFound
      ) {
        rejectedNothingFound = true;
        logRecallTrace("[stella:recall:step]", {
          conversationId: args.conversationId,
          step: searchStep,
          action: "answer-rejected",
          reason: "nothing-found-without-search",
        });
        messages.push(
          response,
          userMessage(
            rejectionText(
              "search_transcripts / search_threads / search_memory",
            ),
          ),
        );
        continue;
      }
      return finish(
        brief ? "answer" : "empty-brief",
        brief || RECALL_EMPTY_BRIEF_TEXT,
      );
    }
    messages.push(response);
    // Count every model turn that issued tools, including the turn rejected
    // because the execution budget is already spent. Claude reports the same
    // round from its assistant event before execution is considered.
    telemetry.addToolRound();
    if (toolRounds >= MAX_RECALL_STEPS) {
      // Budget spent. The tool protocol still demands a result for every
      // issued call, so each gets an out-of-budget error, then one forced
      // final turn synthesizes from what was already gathered.
      for (const call of toolCalls) {
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: "Search budget exhausted — no more searches will run.",
            },
          ],
          isError: true,
          timestamp: Date.now(),
        });
      }
      messages.push(
        userMessage(
          "You are out of search steps. Reply now with the final concise brief (plain text) summarizing what you found. Do not call tools.",
        ),
      );
      const final = await completeWithRetry();
      const brief = readAssistantText(final).trim();
      return finish(
        brief ? "forced-answer" : "budget-exhausted",
        brief || RECALL_BUDGET_EXHAUSTED_TEXT,
      );
    }
    toolRounds += 1;
    // Parallel tool calls in one turn run concurrently against the store.
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const executed = await executeRecallToolCall(
          call.name,
          call.arguments ?? {},
        );
        return {
          call,
          text:
            typeof executed.result === "string"
              ? executed.result
              : (executed.error ?? "Search failed."),
          isError: Boolean(executed.error),
        };
      }),
    );
    for (const { call, text, isError } of results) {
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text }],
        isError,
        timestamp: Date.now(),
      });
    }
  }
};
