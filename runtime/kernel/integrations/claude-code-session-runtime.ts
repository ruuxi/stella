import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "node:string_decoder";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { RuntimeAttachmentRef } from "../../protocol/index.js";
import type {
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import { extractAttachImageBlocks } from "../agent-runtime/tool-adapters.js";
import { executeToolWithInactivityBound } from "./tool-inactivity.js";
import { SAFETY_ABORT_FABLE_ATTEMPTS } from "../agent-runtime/provider-abort-containment.js";
import type {
  FileChangeKind,
  FileChangeRecord,
} from "../../contracts/file-changes.js";
import { sanitizeSensitiveData } from "../../contracts/sensitive-data.js";
import {
  CLAUDE_CODE_MODEL_ALIASES,
  formatClaudeCodeResolvedModel,
  readClaudeCodeResolvedModels,
  recordClaudeCodeResolvedModel,
} from "./claude-code-resolved-models.js";
import {
  buildExternalCliChildEnv,
  resolveExternalCliPath,
} from "./external-cli-resolution.js";
import {
  createClaudeCodeToolMcpHost,
  type ClaudeCodeToolMcpActiveTurn,
  type ClaudeCodeToolMcpHost,
} from "./claude-code-tool-mcp-host.js";

const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
/**
 * Model the fable fallback policy switches a turn to after the configured
 * fable model exhausts its attempts (matches the stella engine's
 * safety-swap target in provider-abort-containment.ts).
 */
const CLAUDE_CODE_FALLBACK_MODEL = "claude-opus-4-8";

/**
 * CLI error text for a model-side refusal (safety / Usage Policy stop) or
 * an exhausted-overload failure — the two failures where retrying the
 * configured model, then falling back, makes sense. Wording verified
 * against CLI 2.1.32; anything else propagates as a normal turn error.
 */
export const isClaudeCodeModelRefusalOrOverloadError = (
  message: string,
): boolean =>
  /unable to respond to this request|usage policy|overloaded/i.test(message);

export const CLAUDE_CODE_LOGIN_REQUIRED_MARKER = "[claude-code/login-required]";

const isClaudeCodeLoginRequiredMessage = (message: string): boolean =>
  /not logged in\s*[·:-]?\s*please run \/login|oauth access token has been revoked|authentication_failed/i.test(
    message,
  );

export class ClaudeCodeLoginRequiredError extends Error {
  constructor() {
    super(
      `${CLAUDE_CODE_LOGIN_REQUIRED_MARKER} Claude Code needs login. Open Terminal, run \`claude\`, then use \`/login\`. Retry in Stella after Claude Code confirms you are signed in.`,
    );
    this.name = "ClaudeCodeLoginRequiredError";
  }
}

/**
 * Model aliases the `claude` CLI accepts via `--model` — canonical list in
 * claude-code-resolved-models.ts. `default` is special: it clears any
 * override and runs the recommended model for the account, so we pass no
 * `--model` flag for it and surface the CLI-reported resolved model next
 * to it in pickers when known.
 */
const CLAUDE_CODE_ALIASES = CLAUDE_CODE_MODEL_ALIASES;

const CLAUDE_CODE_ALIAS_LABELS: Record<
  (typeof CLAUDE_CODE_ALIASES)[number],
  { displayName: string; description: string }
> = {
  default: {
    displayName: "Default",
    description: "Recommended model for your Claude account",
  },
  best: {
    displayName: "Best",
    description: "Most capable model available to you",
  },
  fable: {
    displayName: "Fable",
    description: "Long, hard tasks and deep autonomy",
  },
  opus: {
    displayName: "Opus",
    description: "Latest Opus for complex reasoning",
  },
  sonnet: {
    displayName: "Sonnet",
    description: "Latest Sonnet for everyday work",
  },
  haiku: {
    displayName: "Haiku",
    description: "Fast and efficient for simple tasks",
  },
  opusplan: {
    displayName: "Opus Plan",
    description: "Plans on Opus, executes on Sonnet",
  },
  "sonnet[1m]": {
    displayName: "Sonnet · 1M context",
    description: "Sonnet with a 1M-token context window",
  },
  "opus[1m]": {
    displayName: "Opus · 1M context",
    description: "Opus with a 1M-token context window",
  },
};
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const MAX_STDERR_CAPTURE = 4_000;
const DEFAULT_STEP_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_STEP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Ceiling while native tool_use blocks are unresolved. Native tools run
// inside the CLI where we cannot cancel just the tool, so this is the only
// bound on a turn whose tool never reports a result — long enough for real
// silent work, finite so a wedged CLI can't hang the session forever.
// (Bridged Stella tools are separately bounded at 10 min by
// executeToolWithInactivityBound; this only backstops native tools and
// leaked tracking.)
const DEFAULT_STEP_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const CLAUDE_CODE_COMPACTING_TEXT = "Compacting context";
const CLAUDE_CODE_RUNNING_TEXT = "Working";
/**
 * Loop breaker for Claude Code's own auto-compaction. A healthy turn compacts
 * at most once; repeated compactions within one Stella turn mean the session
 * context can no longer fit and compaction will keep re-triggering forever.
 * Past this count the session process is killed and the turn restarts on a
 * fresh session seeded from `resumeFallbackPrompt` (the checkpoint-compacted
 * Stella history).
 */
const MAX_COMPACTIONS_PER_TURN = 3;
const CLAUDE_CODE_COMPACTION_LOOP_MESSAGE =
  "Claude Code entered a compaction loop.";
/**
 * Recovery budget for flaky step endings within one Stella turn. Covers two
 * observed CLI failure shapes:
 *
 * - The CLI process ends (often cleanly, exit code 0) while a step prompt is
 *   still in flight, without ever emitting its `result` line. Recovery
 *   respawns the CLI and resends the same step prompt — `--resume` restores
 *   the on-disk transcript when one exists, and the missing-resume fallback
 *   reseeds from the checkpoint history otherwise.
 * - The step's `result` arrives without final text. Recovery nudges the
 *   still-live session to restate the answer.
 *
 * Past the budget the turn fails to the caller with an actionable message.
 */
const MAX_STEP_RECOVERIES_PER_TURN = 2;

type ClaudeCodePromptImage = Awaited<
  ReturnType<typeof extractAttachImageBlocks>
>["images"][number];

type ClaudeCodeMcpCallRecord = {
  toolCallId: string;
  toolName: string;
  status: "started" | "completed";
  argsSummary: string;
  outcomeSummary?: string;
};

const summarizeMcpLedgerValue = (value: unknown, maxChars: number): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitizeSensitiveData(value));
  } catch {
    serialized = "[unserializable]";
  }
  return serialized.length > maxChars
    ? `${serialized.slice(0, maxChars)}...[truncated]`
    : serialized;
};

/**
 * The CLI process ended (exit, spawn stream teardown) while a step was still
 * waiting on its `result` line. `exitCode` 0 means a clean-but-early exit.
 */
export class ClaudeCodeProcessEndedError extends Error {
  readonly exitCode: number | null;
  /**
   * Native-tool file writes observed on the failed step before the process
   * ended (vanilla mode only; takeover mode strips CC's file tools). Recovery
   * merges these into the eventual turn result and switches to a
   * non-mutating reconciliation prompt instead of replaying the step.
   */
  readonly fileChanges: FileChangeRecord[];
  readonly mcpCalls: ClaudeCodeMcpCallRecord[];

  constructor(
    message: string,
    exitCode: number | null = null,
    fileChanges: FileChangeRecord[] = [],
    mcpCalls: ClaudeCodeMcpCallRecord[] = [],
  ) {
    super(message);
    this.name = "ClaudeCodeProcessEndedError";
    this.exitCode = exitCode;
    this.fileChanges = fileChanges;
    this.mcpCalls = mcpCalls;
  }
}

/**
 * The step completed but its `result` payload contained no final text.
 */
export class ClaudeCodeMalformedResultError extends Error {
  readonly kind: "empty_result" | "result_error";
  /** Native-tool file writes observed on the failed step (vanilla mode). */
  readonly fileChanges: FileChangeRecord[];
  readonly mcpCalls: ClaudeCodeMcpCallRecord[];

  constructor(
    message: string,
    kind: "empty_result" | "result_error",
    fileChanges: FileChangeRecord[] = [],
    mcpCalls: ClaudeCodeMcpCallRecord[] = [],
  ) {
    super(message);
    this.name = "ClaudeCodeMalformedResultError";
    this.kind = kind;
    this.fileChanges = fileChanges;
    this.mcpCalls = mcpCalls;
  }
}

/**
 * The CLI re-compacted past `MAX_COMPACTIONS_PER_TURN` within one Stella
 * turn. Handled inside `executeStepWithMode` (fresh-session
 * reseed), NOT by the step-recovery budget — a reseeded session that loops
 * again fails loudly. Carries the failed step's observed native file writes
 * so the reseed can reconcile instead of replaying them.
 */
export class ClaudeCodeCompactionLoopError extends Error {
  readonly fileChanges: FileChangeRecord[];
  readonly mcpCalls: ClaudeCodeMcpCallRecord[];

  constructor(
    fileChanges: FileChangeRecord[] = [],
    mcpCalls: ClaudeCodeMcpCallRecord[] = [],
  ) {
    super(CLAUDE_CODE_COMPACTION_LOOP_MESSAGE);
    this.name = "ClaudeCodeCompactionLoopError";
    this.fileChanges = fileChanges;
    this.mcpCalls = mcpCalls;
  }
}

const asRecoverableStepError = (
  error: unknown,
): ClaudeCodeProcessEndedError | ClaudeCodeMalformedResultError | null =>
  error instanceof ClaudeCodeProcessEndedError ||
  error instanceof ClaudeCodeMalformedResultError
    ? error
    : null;

/**
 * Corrective prompt for a malformed step result. The CLI session is still
 * alive and already has the full step context (including any tool result we
 * just forwarded), so the nudge only needs to ask for a well-formed restate.
 */
/**
 * Recovery prompt for a step that died AFTER native file writes were already
 * observed. Blind-replaying the original prompt (or the history-seeded
 * `resumeFallbackPrompt`) could re-run those mutations, so the retry must
 * reconcile instead of redo. Names the affected paths so the model can
 * verify what already landed.
 *
 * `referenceContext` is included (framed as reference-only) when the retry
 * lands on a FRESH session that has no transcript — a bare reconciliation
 * directive would otherwise arrive without any task context.
 */
const buildSideEffectReconciliationPrompt = (
  mutations: readonly FileChangeRecord[],
  mcpCalls: readonly ClaudeCodeMcpCallRecord[] = [],
  referenceContext?: string,
): string => {
  const paths = [...new Set(mutations.map((change) => change.path))];
  return [
    "The previous step was interrupted after side-effecting work may already have been applied.",
    mcpCalls.length > 0
      ? [
          "Stella tool calls already started before the interruption:",
          ...mcpCalls.map((call) =>
            [
              `- ${call.toolName} (${call.toolCallId}, ${call.status})`,
              `  arguments: ${call.argsSummary}`,
              call.status === "completed"
                ? `  completed outcome: ${call.outcomeSummary ?? "[no result]"}`
                : "  outcome unknown; it may have applied before interruption",
            ].join("\n"),
          ),
          "Some of these calls may have already completed even if Claude Code did not receive the result.",
        ].join("\n")
      : "",
    paths.length > 0
      ? [
          "File operations were already applied to:",
          ...paths.map((p) => `- ${p}`),
        ].join("\n")
      : "",
    "Do NOT redo, repeat, or revert those tool calls or file operations.",
    "If you are unsure what was applied, inspect the current state of the affected files first.",
    referenceContext?.trim()
      ? [
          "Original request context, for reference only — do not re-execute work that already completed:",
          referenceContext.trim(),
        ].join("\n\n")
      : "",
    "Reconcile with the current state and report your final answer for the pending request.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
};

const buildResultRetryPrompt = (): string =>
  "Your previous reply produced no result text. Provide your complete final answer to the pending request now.";

const withStepRecoveryExhausted = (error: unknown): Error =>
  new Error(
    `${normalizeErrorMessage(error)} Stella retried ${MAX_STEP_RECOVERIES_PER_TURN} time(s) but Claude Code kept ending the step without a usable result. Check the \`claude\` CLI health (\`claude --version\`, login status), then retry the request.`,
  );

const buildClaudeCodeHookSettings = (): string => {
  const command = `"${process.execPath}" -e ""`;
  return JSON.stringify({
    // Keep the CLI's built-in workflow/keyword-trigger feature from hijacking
    // sub-agent turns whose prompts merely mention workflow-related keywords.
    workflowKeywordTriggerEnabled: false,
    disableWorkflows: true,
    hooks: {
      PreCompact: [{ hooks: [{ type: "command", command }] }],
      PostCompact: [{ hooks: [{ type: "command", command }] }],
    },
  });
};

const CLAUDE_CODE_HOOK_SETTINGS = buildClaudeCodeHookSettings();

type ClaudeUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

type ClaudeCodeStatusChange = {
  state: "running" | "compacting" | "model-fallback";
  text: string;
};

export type ClaudeCodeTurnResult = {
  text: string;
  sessionId: string;
  usage?: ClaudeUsage;
  /**
   * File writes performed by Claude Code's own native tools (Write/Edit/
   * MultiEdit/NotebookEdit), collected from the stream-json `assistant`
   * tool_use blocks. Only vanilla mode produces these (takeover mode strips
   * CC's tools and routes writes through the Stella bridge, which reports
   * fileChanges on each tool result instead). Bash-side writes are invisible
   * here — CC does not report which paths a shell command touched.
   */
  fileChanges?: FileChangeRecord[];
};

type ClaudeCodeTurnRequest = {
  runId: string;
  sessionKey: string;
  persistedSessionId?: string;
  prompt: string;
  resumeFallbackPrompt?: string;
  systemPrompt?: string;
  modelId: string;
  /**
   * Effort/thinking level forwarded to the Claude Code CLI via the
   * `CLAUDE_CODE_EFFORT_LEVEL` env var (`low`/`medium`/`high`/`xhigh`/`max`).
   * Undefined leaves the CLI on its model default.
   */
  effortLevel?: string;
  /**
   * Context capacity in tokens for Claude Code's own auto-compaction,
   * forwarded via the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var. Undefined
   * leaves the CLI on its model-default window (e.g. 200k). Read at CLI
   * startup, so it applies to newly spawned session processes.
   */
  autoCompactWindowTokens?: number;
  /**
   * Percentage (1-100) of `autoCompactWindowTokens` at which the CLI
   * auto-compacts, forwarded via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. The CLI
   * only honors values below its default (~95).
   */
  autoCompactTriggerPct?: number;
  /**
   * Vanilla pass-through mode (per-spawn `model: claude-code` selection):
   * Claude Code keeps its own tool suite, MCP config, and system prompt — no
   * Stella tool bridge, no built-in-tool strip, no MCP override, no Stella
   * system prompt, and no Stella tool host. `tools`/`executeTool` are
   * ignored; the turn's natural result text is the final answer. It is not
   * a bare CLI invocation: the headless plumbing stays (stream-json I/O,
   * `--dangerously-skip-permissions`, compaction-status hook settings). The
   * global claude-code engine takeover (preferences) never sets this.
   */
  vanilla?: boolean;
  cwd?: string;
  /**
   * Stella data dir. When set, the CLI-reported resolved model from the
   * stream-json init event is persisted so pickers can show the real model
   * behind aliases like `default`.
   */
  stellaAppDir?: string;
  cliBridgeSocketPath?: string;
  attachments?: RuntimeAttachmentRef[];
  tools: ToolMetadata[];
  executeTool: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  onToolUpdate?: (args: {
    toolCallId: string;
    toolName: string;
    update: ToolResult;
  }) => void;
  onToolResponseWritten?: (args: {
    toolCallId: string;
    toolName: string;
  }) => void | Promise<void>;
  /** Sanitized CLI init metadata used by the installed protocol probe. */
  onProtocolInit?: (args: {
    tools: string[];
    mcpServers: Array<{ name?: string; status?: string }>;
  }) => void;
  /**
   * Native Claude Code tool boundary observed in vanilla mode. This is a
   * notification only: Claude Code still owns execution and tool results.
   */
  onNativeToolStart?: (args: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => void;
  onStream?: (chunk: string) => void;
  /** Diagnostic boundary: one finalized Claude assistant message is one model round. */
  onModelRound?: (args: { messageId?: string; toolCallCount: number }) => void;
  onStatusChange?: (status: ClaudeCodeStatusChange) => void;
  abortSignal?: AbortSignal;
};

export type ClaudeCodeModelOption = {
  id: string;
  displayName: string;
  description?: string;
  source: "alias" | "anthropic";
};

type QueueJob = {
  request: ClaudeCodeTurnRequest;
  resolve: (value: ClaudeCodeTurnResult) => void;
  reject: (reason?: unknown) => void;
};

type ClaudeCodeStepResult = {
  message: string;
  sessionId: string;
  usage?: ClaudeUsage;
  /** Native-tool file writes observed during this step (vanilla mode). */
  fileChanges?: FileChangeRecord[];
};

type PendingClaudeCodePrompt = {
  request: ClaudeCodeTurnRequest;
  resolve: (value: ClaudeCodeStepResult) => void;
  reject: (reason?: unknown) => void;
  emitStreamDelta: (event: Record<string, unknown>) => void;
  /** Accumulates native-tool file writes seen while this prompt streams. */
  fileChanges: FileChangeRecord[];
  /** Native MCP calls that started while this prompt was in flight. */
  mcpCalls: ClaudeCodeMcpCallRecord[];
  abortListener?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasOutput?: boolean;
  activeNativeToolUseIds: Set<string>;
};

type ClaudeCodeStreamingProcess = {
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  /**
   * Stateful UTF-8 decoder for stdout chunking: a multi-byte character
   * split across chunk boundaries must not be corrupted into U+FFFD
   * (plain `chunk.toString("utf8")` decodes each chunk independently).
   */
  stdoutDecoder: StringDecoder;
  stderrText: string;
  finalSessionId: string;
  pending: PendingClaudeCodePrompt[];
  closed: boolean;
  /** True while the CLI is inside a compaction (PreCompact seen, no PostCompact yet). */
  compacting: boolean;
  /** Discrete compactions observed in the current Stella turn (reset per turn). */
  compactionCount: number;
  /**
   * Fingerprint of the spawn-time configuration (model, effort, vanilla
   * mode, system prompt, auto-compact env). A later request with a
   * different fingerprint restarts the process so mid-session model or
   * effort changes apply on the next prompt instead of silently keeping
   * the old configuration until the process dies.
   */
  launchConfig: string;
};

type SessionState = {
  sessionId: string;
  cwd?: string;
  lastUsedAt: number;
  turnCount: number;
  resumeReady: boolean;
  running: boolean;
  queue: QueueJob[];
  artifactDir?: string;
  process?: ClaudeCodeStreamingProcess;
  /** Private native-tool server reused for this CLI session/catalog. */
  mcpHost?: ClaudeCodeToolMcpHost;
  mcpToolCatalogKey?: string;
  mcpConfigPath?: string;
  /** Turn-scoped callbacks consulted lazily by the session MCP host. */
  activeMcpTurn?: ClaudeCodeToolMcpActiveTurn;
  activeNativeToolUseCorrelator?: {
    observe: (args: {
      toolCallId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
    }) => void;
    observeStreamEvent: (event: Record<string, unknown>) => void;
    observeAssistantMessage: (
      event: Record<string, unknown>,
    ) => ClaudeToolUseTruncation | null;
    resolveToolUseIntegrity: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      signal?: AbortSignal,
      timeoutMs?: number,
    ) => Promise<ClaudeToolUseTruncation | undefined>;
    claim: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<string>;
  };
  /** A successful NoResponse tool call permits this native turn to end empty. */
  allowEmptyNativeFinal?: boolean;
  /**
   * True once a model fallback has been surfaced for this session — either
   * our own fable fallback policy engaging or the CLI announcing a switch it
   * made on its own (e.g. a `--fallback-model` from the user's CLI
   * settings). Latched so the heads-up toast fires at most once per session.
   */
  modelFallbackNotified?: boolean;
  /**
   * Model the fable fallback policy switched the CURRENT turn to after the
   * configured model exhausted its attempts (see
   * `applyFableFallbackPolicy`). Cleared at the start of every turn so each
   * new user message reattempts the configured model.
   */
  modelOverride?: string;
  /**
   * Consecutive refusal/overload failures of the configured fable model in
   * the current turn. Reset at turn start; at SAFETY_ABORT_FABLE_ATTEMPTS
   * the turn falls back via `modelOverride`.
   */
  fableSafetyFailures?: number;
};

/**
 * Message-level stop reasons that mean the model's stream ended BEFORE the
 * content block it was generating was complete. `refusal` is a mid-stream
 * safety stop (the API cuts generation the moment a classifier fires);
 * `max_tokens` is the output budget running out. In both cases the CLI still
 * repairs the partial `input_json_delta` into syntactically valid JSON and
 * dispatches the tool call, so a half-written string argument arrives here
 * looking exactly like a complete one.
 */
const TRUNCATING_STOP_REASONS = new Set(["refusal", "max_tokens"]);

export type ClaudeToolUseTruncation = {
  toolName: string;
  stopReason: string;
  /** `stop_details.category` when the API supplies one (e.g. "cyber"). */
  category?: string;
  explanation?: string;
};

/**
 * Detects an `assistant` stream event whose trailing content block is a
 * `tool_use` that was cut off mid-generation.
 *
 * The CLI emits one `assistant` event per finalized content block, stamping
 * each with the message-level `stop_reason`. A truncating stop always cuts the
 * block that was in flight, which is the LAST block of the message — so a
 * `tool_use` that is followed by another block completed normally and must not
 * be flagged. Requiring the tool_use to be last keeps this free of false
 * positives on multi-block messages.
 */
export const getClaudeCodeTruncatedToolUseFromStreamEvent = (
  event: Record<string, unknown>,
):
  | (ClaudeToolUseTruncation & {
      toolCallId: string;
      toolArgs: Record<string, unknown>;
    })
  | null => {
  if (event.type !== "assistant") return null;
  const message = asObject(event.message);
  const stopReason =
    typeof message?.stop_reason === "string" ? message.stop_reason : "";
  if (!TRUNCATING_STOP_REASONS.has(stopReason)) return null;
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const block = asObject(content[content.length - 1]);
  if (
    block?.type !== "tool_use" ||
    typeof block.id !== "string" ||
    typeof block.name !== "string"
  ) {
    return null;
  }
  const details = asObject(message?.stop_details);
  return {
    toolCallId: block.id,
    toolName: block.name,
    toolArgs: asObject(block.input) ?? {},
    stopReason,
    ...(typeof details?.category === "string"
      ? { category: details.category }
      : {}),
    ...(typeof details?.explanation === "string"
      ? { explanation: details.explanation }
      : {}),
  };
};

export const describeClaudeToolUseTruncation = (
  truncation: ClaudeToolUseTruncation,
): string =>
  `Claude's stream ended with stop_reason "${truncation.stopReason}"` +
  `${truncation.category ? ` (${truncation.category})` : ""} while it was ` +
  `still writing the arguments for \`${truncation.toolName}\`, so those ` +
  `arguments are cut off mid-value.`;

const stableToolArgs = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableToolArgs).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableToolArgs(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const claudeToolKey = (
  toolName: string,
  toolArgs: Record<string, unknown>,
): string => {
  const normalizedName = toolName.includes("__")
    ? (toolName.split("__").at(-1) ?? toolName)
    : toolName;
  return crypto
    .createHash("sha256")
    .update(normalizedName)
    .update("\0")
    .update(stableToolArgs(toolArgs))
    .digest("hex");
};

/**
 * How long an inbound MCP call waits for the finalized `assistant` event that
 * carries its `stop_reason` before giving up and running anyway.
 *
 * The CLI writes that event to stdout immediately before issuing the MCP HTTP
 * call, so in practice the verdict is already recorded and the wait is zero.
 * The ceiling only covers the few-millisecond window where the HTTP request
 * beats the pipe read; it is small because the gate FAILS OPEN — an unmatched
 * call must never be delayed or blocked on the strength of missing evidence.
 */
const TOOL_USE_INTEGRITY_SETTLE_MS = 250;

export const createClaudeNativeToolUseCorrelator = () => {
  const queued = new Map<string, string[]>();
  const waiters = new Map<string, Array<(id: string) => void>>();
  const observedIds = new Set<string>();
  /** Keys of tool_use blocks a finalized assistant event proved truncated. */
  const truncatedKeys = new Map<string, ClaudeToolUseTruncation>();
  /** Keys a finalized assistant event has adjudicated (truncated or clean). */
  const settledKeys = new Set<string>();
  const integrityWaiters = new Map<string, Array<() => void>>();
  const settleKey = (key: string) => {
    settledKeys.add(key);
    const pending = integrityWaiters.get(key);
    integrityWaiters.delete(key);
    for (const resolve of pending ?? []) resolve();
  };
  const streamingBlocks = new Map<
    number,
    {
      toolCallId: string;
      toolName: string;
      initialInput: Record<string, unknown>;
      partialJson: string;
    }
  >();
  const observe = (args: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    if (observedIds.has(args.toolCallId)) return;
    observedIds.add(args.toolCallId);
    const key = claudeToolKey(args.toolName, args.toolArgs);
    const waiter = waiters.get(key)?.shift();
    if (waiter) {
      waiter(args.toolCallId);
      return;
    }
    const values = queued.get(key) ?? [];
    if (!values.includes(args.toolCallId)) values.push(args.toolCallId);
    queued.set(key, values);
  };
  return {
    observe,
    /**
     * Records the integrity verdict a finalized `assistant` event carries for
     * the tool_use blocks it contains. Returns the truncation when this event
     * proved one, so the caller can also surface it to the user (the call may
     * already be executing, in which case the gate below cannot stop it).
     */
    observeAssistantMessage(
      event: Record<string, unknown>,
    ): ClaudeToolUseTruncation | null {
      if (event.type !== "assistant") return null;
      const content = asObject(event.message)?.content;
      if (!Array.isArray(content)) return null;
      const truncated = getClaudeCodeTruncatedToolUseFromStreamEvent(event);
      for (const raw of content) {
        const block = asObject(raw);
        if (block?.type !== "tool_use" || typeof block.name !== "string") {
          continue;
        }
        const key = claudeToolKey(block.name, asObject(block.input) ?? {});
        if (truncated && block.id === truncated.toolCallId) {
          truncatedKeys.set(key, truncated);
        }
        settleKey(key);
      }
      return truncated;
    },
    /**
     * Verdict for an inbound MCP call: the truncation that cut its arguments,
     * or undefined when the arguments are whole OR when no finalized event
     * arrived in time to say. Fails open by design — see the settle constant.
     */
    async resolveToolUseIntegrity(
      toolName: string,
      toolArgs: Record<string, unknown>,
      signal?: AbortSignal,
      timeoutMs: number = TOOL_USE_INTEGRITY_SETTLE_MS,
    ): Promise<ClaudeToolUseTruncation | undefined> {
      const key = claudeToolKey(toolName, toolArgs);
      if (!settledKeys.has(key)) {
        await new Promise<void>((resolve) => {
          const entries = integrityWaiters.get(key) ?? [];
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            const index = entries.indexOf(finish);
            if (index >= 0) entries.splice(index, 1);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          timer.unref?.();
          entries.push(finish);
          integrityWaiters.set(key, entries);
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
      return truncatedKeys.get(key);
    },
    observeStreamEvent(event: Record<string, unknown>) {
      if (event.type !== "stream_event") return;
      const source = asObject(event.event);
      const index = asNumber(source?.index);
      if (!source || index === undefined || !Number.isInteger(index)) return;
      if (source.type === "content_block_start") {
        const block = asObject(source.content_block);
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          streamingBlocks.set(index, {
            toolCallId: block.id,
            toolName: block.name,
            initialInput: asObject(block.input) ?? {},
            partialJson: "",
          });
        }
        return;
      }
      const pending = streamingBlocks.get(index);
      if (!pending) return;
      if (source.type === "content_block_delta") {
        const delta = asObject(source.delta);
        if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          pending.partialJson += delta.partial_json;
        }
        return;
      }
      if (source.type !== "content_block_stop") return;
      streamingBlocks.delete(index);
      let toolArgs = pending.initialInput;
      if (pending.partialJson.trim()) {
        try {
          const parsed = JSON.parse(pending.partialJson) as unknown;
          toolArgs = asObject(parsed) ?? pending.initialInput;
        } catch {
          // The finalized assistant event remains a safe fallback. Never bind
          // an MCP mutation to malformed or incomplete streamed arguments.
          return;
        }
      }
      observe({
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        toolArgs,
      });
    },
    async claim(
      toolName: string,
      toolArgs: Record<string, unknown>,
      signal: AbortSignal,
    ) {
      const key = claudeToolKey(toolName, toolArgs);
      const existing = queued.get(key)?.shift();
      if (existing) return existing;
      return await new Promise<string>((resolve, reject) => {
        const entries = waiters.get(key) ?? [];
        const onAbort = () => {
          const index = entries.indexOf(onObserved);
          if (index >= 0) entries.splice(index, 1);
          reject(signal.reason ?? new Error("Claude tool call canceled."));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          const index = entries.indexOf(onObserved);
          if (index >= 0) entries.splice(index, 1);
          reject(
            new Error(
              "Timed out waiting for Claude's durable tool_use identity.",
            ),
          );
        }, 5_000);
        timer.unref?.();
        const onObserved = (id: string) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(id);
        };
        entries.push(onObserved);
        waiters.set(key, entries);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
  };
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
};

const textArrayMessage = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
};

const isSessionAlreadyInUseError = (message: string): boolean =>
  /Session ID .* is already in use\./i.test(message);

const isMissingResumeSessionError = (message: string): boolean =>
  /No conversation found with session ID:/i.test(message);

const configuredTimeoutMs = (envName: string, fallbackMs: number): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

/**
 * True only when the child has actually terminated. `child.killed` must
 * NOT be used for ladder guards: it flips true as soon as any signal was
 * SENT, which previously made every later rung unreachable — after the
 * SIGINT in `abortProcess`, neither SIGTERM nor SIGKILL could ever fire,
 * so a signal-ignoring CLI survived cancellation.
 */
const processIsDead = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const killProcess = (child: ChildProcessWithoutNullStreams) => {
  if (processIsDead(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Process may have already exited.
  }

  const sigkillTimer = setTimeout(() => {
    if (processIsDead(child)) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }, SIGKILL_TIMEOUT_MS);

  child.once("exit", () => clearTimeout(sigkillTimer));
};

const abortProcess = (child: ChildProcessWithoutNullStreams) => {
  if (processIsDead(child)) return;
  try {
    child.kill("SIGINT");
  } catch {
    // Ignore and fall through to SIGTERM/SIGKILL.
  }

  setTimeout(() => {
    killProcess(child);
  }, SIGTERM_TIMEOUT_MS);
};

const parseClaudeCodeModel = (modelId: string): string | undefined => {
  const normalized = modelId.trim();
  if (!normalized.startsWith(CLAUDE_CODE_MODEL_PREFIX)) return undefined;
  const suffix = normalized.slice(CLAUDE_CODE_MODEL_PREFIX.length).trim();
  if (!suffix || suffix === "default") return undefined;
  return suffix;
};

const mimeExtension = (mimeType: string): string => {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
};

const parseDataUrlAttachment = (
  attachment: RuntimeAttachmentRef,
): { mimeType: string; data: Buffer } | null => {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(attachment.url.trim());
  if (!match) {
    return null;
  }
  try {
    return {
      mimeType: attachment.mimeType?.trim() || match[1],
      data: Buffer.from(match[2], "base64"),
    };
  } catch {
    return null;
  }
};

const ensureArtifactDir = (session: SessionState): string => {
  if (!session.artifactDir) {
    session.artifactDir = path.join(
      os.tmpdir(),
      "stella-claude-code",
      session.sessionId,
    );
  }
  fs.mkdirSync(session.artifactDir, { recursive: true });
  return session.artifactDir;
};

const materializeAttachments = (
  session: SessionState,
  attachments?: RuntimeAttachmentRef[],
): string[] => {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const artifactDir = ensureArtifactDir(session);
  const notes: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const parsed = parseDataUrlAttachment(attachment);
    if (!parsed) {
      continue;
    }
    const filePath = path.join(
      artifactDir,
      `attachment-${index + 1}-${crypto.randomUUID()}${mimeExtension(parsed.mimeType)}`,
    );
    fs.writeFileSync(filePath, parsed.data);
    notes.push(`${filePath} (${parsed.mimeType})`);
  }
  return notes;
};

const buildInitialPrompt = (
  session: SessionState,
  request: ClaudeCodeTurnRequest,
): string => {
  const attachments = materializeAttachments(session, request.attachments);
  if (attachments.length === 0) {
    return request.prompt;
  }
  return [
    request.prompt.trim(),
    "User-provided attachments for this turn:",
    ...attachments.map((entry) => `- ${entry}`),
    "Treat these absolute file paths as attached image inputs for this turn.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
};

export const buildClaudeCodeNativeToolRuntimePrompt = (
  systemPrompt: string | undefined,
): string =>
  [
    systemPrompt?.trim() ?? "",
    "Claude Code built-in tools are disabled for this session. Use the available Stella tools when needed and answer the user normally when finished.",
    "If you successfully call NoResponse and have nothing else to say, finish without adding a user-visible response.",
    "Never mention MCP, missing Claude tools, or the raw tool protocol to the user.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseStreamJsonLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const getClaudeCodeTextDeltaFromStreamEvent = (
  event: Record<string, unknown>,
): string | null => {
  if (event.type !== "stream_event") {
    return null;
  }
  const nested = asObject(event.event);
  const source = nested ?? event;
  if (source.type === "content_block_delta") {
    const delta = asObject(source.delta);
    if (!delta) return null;
    if (
      (delta.type === "text_delta" || delta.type === "thinking_delta") &&
      typeof delta.text === "string"
    ) {
      return delta.text;
    }
    if (typeof delta.text === "string") {
      return delta.text;
    }
    return null;
  }
  if (
    (source.type === "text_delta" || source.type === "thinking_delta") &&
    typeof source.text === "string"
  ) {
    return source.text;
  }
  return null;
};

/**
 * Claude Code native file tools whose stream-json `tool_use` inputs name the
 * file they touch. `Write` may create or overwrite; without a filesystem
 * probe we call it an `add` (the chat artifact card treats add/update the
 * same for display). Bash writes are inherently untrackable from the stream.
 */
const CLAUDE_CODE_NATIVE_FILE_TOOLS: Record<
  string,
  { pathKey: string; kind: FileChangeKind }
> = {
  Write: { pathKey: "file_path", kind: { type: "add" } },
  Edit: { pathKey: "file_path", kind: { type: "update" } },
  MultiEdit: { pathKey: "file_path", kind: { type: "update" } },
  NotebookEdit: { pathKey: "notebook_path", kind: { type: "update" } },
};

/**
 * Extract native-tool file writes from one parsed stream-json line. Vanilla
 * mode is the only mode where Claude Code runs its own Write/Edit tools, but
 * the collector is safe to run on every line: takeover mode strips CC's
 * tools (`--tools ""`), so its assistant messages never carry these blocks.
 */
export const collectClaudeCodeNativeFileChanges = (
  event: Record<string, unknown>,
): FileChangeRecord[] => {
  if (event.type !== "assistant") return [];
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const out: FileChangeRecord[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const spec = CLAUDE_CODE_NATIVE_FILE_TOOLS[block.name];
    if (!spec) continue;
    const input = asObject(block.input);
    const filePath = input?.[spec.pathKey];
    if (typeof filePath !== "string" || !filePath.trim()) continue;
    out.push({ path: filePath.trim(), kind: spec.kind });
  }
  return out;
};

const updateClaudeCodeNativeToolActivity = (
  event: Record<string, unknown>,
  activeToolUseIds: Set<string>,
  onNativeToolStart?: ClaudeCodeTurnRequest["onNativeToolStart"],
): boolean => {
  const before = activeToolUseIds.size;
  const startToolUse = (block: Record<string, unknown> | null) => {
    if (block?.type !== "tool_use" || typeof block.id !== "string") {
      return;
    }
    const alreadyActive = activeToolUseIds.has(block.id);
    activeToolUseIds.add(block.id);
    if (alreadyActive) {
      return;
    }
    onNativeToolStart?.({
      toolCallId: block.id,
      toolName:
        typeof block.name === "string" && block.name.trim()
          ? block.name.trim()
          : "claude_native_tool",
      toolArgs: asObject(block.input) ?? {},
    });
  };
  const updateFromContent = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asObject(raw);
      if (block?.type === "tool_use") {
        startToolUse(block);
      } else if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        activeToolUseIds.delete(block.tool_use_id);
      }
    }
  };

  if (event.type === "assistant" || event.type === "user") {
    updateFromContent(asObject(event.message)?.content);
  }
  if (event.type === "stream_event") {
    const source = asObject(event.event);
    if (source?.type === "content_block_start") {
      const block = asObject(source.content_block);
      startToolUse(block);
    }
  }
  return before !== activeToolUseIds.size;
};

const observeFinalizedClaudeToolUses = (
  event: Record<string, unknown>,
  observe?: (args: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => void,
): void => {
  if (event.type !== "assistant" || !observe) return;
  const content = asObject(event.message)?.content;
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = asObject(raw);
    if (
      block?.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    ) {
      continue;
    }
    observe({
      toolCallId: block.id,
      toolName: block.name,
      toolArgs: asObject(block.input) ?? {},
    });
  }
};

const fileChangeDedupeKey = (record: FileChangeRecord): string =>
  `${record.kind.type}:${record.path}:${record.kind.type === "update" ? (record.kind.move_path ?? "") : ""}`;

const mergeFileChanges = (
  target: FileChangeRecord[],
  seen: Set<string>,
  records: ReadonlyArray<FileChangeRecord> | undefined,
): void => {
  for (const record of records ?? []) {
    const key = fileChangeDedupeKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(record);
  }
};

const mergeMcpCalls = (
  target: ClaudeCodeMcpCallRecord[],
  records: readonly ClaudeCodeMcpCallRecord[] | undefined,
): void => {
  for (const record of records ?? []) {
    const existing = target.find(
      (entry) => entry.toolCallId === record.toolCallId,
    );
    if (existing) {
      if (record.status === "completed") {
        existing.status = "completed";
        existing.outcomeSummary = record.outcomeSummary;
      }
      continue;
    }
    target.push({ ...record });
  }
};

export const createClaudeCodeStreamEmitter = (
  onStream?: (chunk: string) => void,
) => {
  let lastVisibleChar = "";
  let boundaryPending = false;
  return (event: Record<string, unknown>) => {
    if (event.type !== "stream_event") return;
    const source = asObject(event.event) ?? event;
    if (source.type === "message_start") {
      boundaryPending = true;
      return;
    }
    if (source.type === "content_block_start") {
      if (asObject(source.content_block)?.type === "text") {
        boundaryPending = true;
      }
      return;
    }
    const delta = getClaudeCodeTextDeltaFromStreamEvent(event);
    if (!delta) return;
    let out = delta;
    if (
      boundaryPending &&
      lastVisibleChar &&
      !/\s/.test(lastVisibleChar) &&
      !/^\s/.test(out)
    ) {
      out = `\n\n${out}`;
    }
    boundaryPending = false;
    lastVisibleChar = out.at(-1) ?? lastVisibleChar;
    onStream?.(out);
  };
};

export const getClaudeCodeModelRoundFromStreamEvent = (
  event: Record<string, unknown>,
): { messageId?: string; toolCallCount: number } | null => {
  if (event.type !== "assistant") return null;
  const message = asObject(event.message);
  const content = message?.content;
  const messageId =
    typeof message?.id === "string" && message.id.trim()
      ? message.id.trim()
      : undefined;
  if (!Array.isArray(content)) {
    return { ...(messageId ? { messageId } : {}), toolCallCount: 0 };
  }
  return {
    ...(messageId ? { messageId } : {}),
    toolCallCount: content.filter((raw) => asObject(raw)?.type === "tool_use")
      .length,
  };
};

export const getClaudeCodeStatusChangeFromStreamEvent = (
  event: Record<string, unknown>,
): ClaudeCodeStatusChange | null => {
  const type = typeof event.type === "string" ? event.type : "";
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  const hookEvent =
    typeof event.hook_event === "string"
      ? event.hook_event
      : typeof event.hookEvent === "string"
        ? event.hookEvent
        : "";
  const statusValue = typeof event.status === "string" ? event.status : "";

  if (
    type === "system" &&
    subtype === "status" &&
    statusValue === "compacting"
  ) {
    return {
      state: "compacting",
      text: CLAUDE_CODE_COMPACTING_TEXT,
    };
  }

  if (
    type === "system" &&
    (subtype === "hook_started" || subtype === "hook_response")
  ) {
    if (hookEvent === "PreCompact") {
      return {
        state: "compacting",
        text: CLAUDE_CODE_COMPACTING_TEXT,
      };
    }
    if (hookEvent === "PostCompact") {
      return {
        state: "running",
        text: CLAUDE_CODE_RUNNING_TEXT,
      };
    }
  }
  return null;
};

export type ClaudeCodeModelFallback = {
  /** Configured model the CLI was running before the fallback (pretty name). */
  fromModel: string;
  /** Model the CLI stickily downgraded the session to (pretty name). */
  toModel: string;
  /** Ready-to-toast description naming what happened plus the from/to models. */
  text: string;
};

/**
 * The CLI has no structured event for a model fallback — it announces it as
 * a `system`/`informational` message with exactly this content (verified
 * against the CLI bundle: `Model fallback triggered: switching from ${X} to
 * ${Y}`). Text match is brittle across CLI versions by nature; if the
 * wording drops the model ids we still detect the switch and fall back to
 * generic labels.
 */
const CLAUDE_CODE_MODEL_FALLBACK_RE =
  /^Model fallback triggered(?::? switching from (\S+) to (\S+))?/;

/**
 * Detect the CLI's model-fallback announcement on the stream. When the
 * configured model errors as overloaded (529) and a `--fallback-model` is
 * in play (e.g. from the user's own CLI settings — we don't pass one; our
 * fable fallback policy lives in `applyFableFallbackPolicy`), the CLI
 * stickily switches the session's main-loop model to the fallback for the
 * rest of the session — the model actually answering is no longer the
 * configured one. We surface that switch as a visible toast,
 * pretty-printing the from/to ids parsed out of the message. Returns null
 * for any other event.
 */
export const getClaudeCodeModelFallbackFromStreamEvent = (
  event: Record<string, unknown>,
): ClaudeCodeModelFallback | null => {
  if (event.type !== "system" || event.subtype !== "informational") {
    return null;
  }
  const content = typeof event.content === "string" ? event.content : "";
  const match = CLAUDE_CODE_MODEL_FALLBACK_RE.exec(content);
  if (!match) {
    return null;
  }
  const fromModel = match[1]
    ? formatClaudeCodeResolvedModel(match[1])
    : "the configured model";
  const toModel = match[2]
    ? formatClaudeCodeResolvedModel(match[2])
    : "a fallback model";
  const text =
    `Claude Code switched this session from ${fromModel} to ${toModel} ` +
    `because ${fromModel} was unavailable. ` +
    `The rest of this session runs on ${toModel}.`;
  return { fromModel, toModel, text };
};

const cleanupSessionArtifacts = (session: SessionState) => {
  if (!session.artifactDir) {
    return;
  }
  try {
    fs.rmSync(session.artifactDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
  session.artifactDir = undefined;
};

const resetSessionMcpClients = (session: SessionState, reason: unknown) => {
  void session.mcpHost?.resetClientSessions(reason).catch(() => {
    // Process teardown must continue even if a stale transport resists close.
  });
};

const cleanupSessionProcess = (session: SessionState) => {
  if (!session.process) {
    return;
  }
  resetSessionMcpClients(
    session,
    new Error("Claude Code session process was closed."),
  );
  killProcess(session.process.child);
  session.process = undefined;
};

const cleanupSessionMcpHost = (session: SessionState) => {
  const host = session.mcpHost;
  session.mcpHost = undefined;
  session.mcpToolCatalogKey = undefined;
  session.mcpConfigPath = undefined;
  session.activeMcpTurn = undefined;
  if (host) {
    void host.close().catch(() => {
      // The private loopback listener is best-effort cleanup on teardown.
    });
  }
};

const ensureSessionState = (
  sessions: Map<string, SessionState>,
  request: Pick<
    ClaudeCodeTurnRequest,
    "sessionKey" | "persistedSessionId" | "cwd"
  >,
  sessionKey: string,
  cwd?: string,
): SessionState => {
  const normalizedCwd = cwd?.trim() || undefined;
  const persistedSessionId = request.persistedSessionId?.trim() || undefined;
  const existing = sessions.get(sessionKey);
  if (existing) {
    if (existing.cwd === normalizedCwd) {
      if (persistedSessionId && existing.turnCount === 0) {
        existing.sessionId = persistedSessionId;
        existing.turnCount = 1;
        existing.resumeReady = true;
      }
      return existing;
    }
    cleanupSessionProcess(existing);
    cleanupSessionMcpHost(existing);
    cleanupSessionArtifacts(existing);
    const replacement: SessionState = {
      sessionId: persistedSessionId ?? crypto.randomUUID(),
      cwd: normalizedCwd,
      lastUsedAt: Date.now(),
      turnCount: persistedSessionId ? 1 : 0,
      resumeReady: Boolean(persistedSessionId),
      running: false,
      queue: [],
    };
    sessions.set(sessionKey, replacement);
    return replacement;
  }
  const created: SessionState = {
    sessionId: persistedSessionId ?? crypto.randomUUID(),
    cwd: normalizedCwd,
    lastUsedAt: Date.now(),
    turnCount: persistedSessionId ? 1 : 0,
    resumeReady: Boolean(persistedSessionId),
    running: false,
    queue: [],
  };
  sessions.set(sessionKey, created);
  return created;
};

class ClaudeCodeSessionRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly activeProcesses = new Map<
    string,
    ChildProcessWithoutNullStreams
  >();
  private readonly closeWhenIdle = new Set<string>();
  private readonly idleCloseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
    this.clearIdleCloseTimer(request.sessionKey);
    const session = ensureSessionState(
      this.sessions,
      request,
      request.sessionKey,
      request.cwd,
    );
    session.lastUsedAt = Date.now();

    return await new Promise<ClaudeCodeTurnResult>((resolve, reject) => {
      session.queue.push({ request, resolve, reject });
      this.pumpSession(request.sessionKey, session);
    });
  }

  /**
   * Diagnostic/test hook: whether a live CLI child is tracked for the
   * session key. Guards against restart races where a stale close handler
   * would otherwise evict the replacement child from tracking.
   */
  hasActiveProcess(sessionKey: string): boolean {
    const child = this.activeProcesses.get(sessionKey);
    return Boolean(child && !child.killed && child.exitCode === null);
  }

  closeSessionWhenIdle(sessionKey: string): void {
    this.clearIdleCloseTimer(sessionKey);
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (session.running || session.queue.length > 0) {
      this.closeWhenIdle.add(sessionKey);
      return;
    }
    this.closeSession(sessionKey, session);
  }

  scheduleSessionCloseWhenIdle(sessionKey: string, timeoutMs: number): void {
    this.clearIdleCloseTimer(sessionKey);
    const timer = setTimeout(
      () => this.closeSessionWhenIdle(sessionKey),
      Math.max(1_000, timeoutMs),
    );
    timer.unref?.();
    this.idleCloseTimers.set(sessionKey, timer);
  }

  private clearIdleCloseTimer(sessionKey: string): void {
    const timer = this.idleCloseTimers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.idleCloseTimers.delete(sessionKey);
  }

  private closeSession(sessionKey: string, session: SessionState): void {
    this.clearIdleCloseTimer(sessionKey);
    const child = session.process?.child;
    if (child && this.activeProcesses.get(sessionKey) === child) {
      this.activeProcesses.delete(sessionKey);
    }
    cleanupSessionProcess(session);
    cleanupSessionMcpHost(session);
    cleanupSessionArtifacts(session);
    this.sessions.delete(sessionKey);
    this.closeWhenIdle.delete(sessionKey);
  }

  dispose(): void {
    for (const child of this.activeProcesses.values()) {
      killProcess(child);
    }
    this.activeProcesses.clear();
    for (const session of this.sessions.values()) {
      cleanupSessionProcess(session);
      cleanupSessionMcpHost(session);
      cleanupSessionArtifacts(session);
    }
    this.sessions.clear();
    this.closeWhenIdle.clear();
    for (const timer of this.idleCloseTimers.values()) clearTimeout(timer);
    this.idleCloseTimers.clear();
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (session.running || session.queue.length > 0) continue;
      if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) {
        cleanupSessionProcess(session);
        cleanupSessionMcpHost(session);
        cleanupSessionArtifacts(session);
        this.sessions.delete(sessionKey);
      }
    }
  }

  private pumpSession(sessionKey: string, session: SessionState): void {
    if (session.running) return;
    const job = session.queue.shift();
    if (!job) {
      this.pruneIdleSessions();
      return;
    }

    session.running = true;
    void this.executeTurn(session, job.request)
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        session.running = false;
        session.lastUsedAt = Date.now();
        if (this.closeWhenIdle.has(sessionKey) && session.queue.length === 0) {
          this.closeSession(sessionKey, session);
          return;
        }
        this.pumpSession(sessionKey, session);
      });
  }

  private async executeTurn(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
  ): Promise<ClaudeCodeTurnResult> {
    // Vanilla mode sends the prompt to stock Claude Code untouched: no
    // Stella runtime contract, no system-prompt override.
    const effectiveSystemPrompt = request.vanilla
      ? ""
      : buildClaudeCodeNativeToolRuntimePrompt(request.systemPrompt);
    const turnFileChanges: FileChangeRecord[] = [];
    const turnFileChangeKeys = new Set<string>();
    const prompt = buildInitialPrompt(session, request);

    // Every user message reattempts the configured model: a fallback from a
    // previous turn does not stick to the session. The next
    // ensureStreamingProcess sees the config change and restarts the CLI on
    // the configured model with --resume.
    session.modelOverride = undefined;
    session.fableSafetyFailures = 0;
    session.allowEmptyNativeFinal = false;

    // The compaction loop breaker counts per Stella turn.
    if (session.process) {
      session.process.compacting = false;
      session.process.compactionCount = 0;
    }

    if (!request.vanilla) {
      const nativeToolUseCorrelator = createClaudeNativeToolUseCorrelator();
      session.activeNativeToolUseCorrelator = nativeToolUseCorrelator;
      session.activeMcpTurn = {
        // The persisted Claude session is the conversation boundary. Native
        // tool_use.id distinguishes invocations within it; Stella run IDs can
        // change during crash recovery and must not alter replay identity.
        identityScope: request.sessionKey,
        claimNativeToolUseId: (toolName, toolArgs, signal) =>
          nativeToolUseCorrelator.claim(toolName, toolArgs, signal),
        checkToolUseIntegrity: (toolName, toolArgs, signal) =>
          nativeToolUseCorrelator.resolveToolUseIntegrity(
            toolName,
            toolArgs,
            signal,
          ),
        executeTool: async (
          toolCallId,
          toolName,
          toolArgs,
          toolSignal,
          onUpdate,
        ) => {
          const pending = session.process?.pending[0];
          const callRecord: ClaudeCodeMcpCallRecord = {
            toolCallId,
            toolName,
            status: "started",
            argsSummary: summarizeMcpLedgerValue(toolArgs, 4_000),
          };
          pending?.mcpCalls.push(callRecord);
          const signal =
            request.abortSignal && toolSignal
              ? AbortSignal.any([request.abortSignal, toolSignal])
              : (request.abortSignal ?? toolSignal);
          const toolResult = await executeToolWithInactivityBound({
            toolName,
            signal,
            run: (boundedSignal, onActivity) =>
              request.executeTool(
                toolCallId,
                toolName,
                toolArgs,
                boundedSignal,
                (update) => {
                  onActivity();
                  onUpdate?.(update);
                  request.onToolUpdate?.({
                    toolCallId,
                    toolName,
                    update,
                  });
                },
              ),
          });
          callRecord.status = "completed";
          callRecord.outcomeSummary = summarizeMcpLedgerValue(
            {
              result: toolResult.result,
              details: toolResult.details,
              error: toolResult.error,
            },
            6_000,
          );
          if (toolName === "NoResponse" && !toolResult.error) {
            session.allowEmptyNativeFinal = true;
          }
          mergeFileChanges(
            turnFileChanges,
            turnFileChangeKeys,
            toolResult.fileChanges,
          );
          if (pending) {
            const pendingKeys = new Set(
              pending.fileChanges.map(fileChangeDedupeKey),
            );
            mergeFileChanges(
              pending.fileChanges,
              pendingKeys,
              toolResult.fileChanges,
            );
          }
          return toolResult;
        },
        onToolResponseWritten: request.onToolResponseWritten,
      };
    }

    try {
      const response = await this.executeStepWithRecovery(
        session,
        request,
        effectiveSystemPrompt,
        prompt,
        [],
        { remaining: MAX_STEP_RECOVERIES_PER_TURN },
      );
      mergeFileChanges(
        turnFileChanges,
        turnFileChangeKeys,
        response.fileChanges,
      );
      return {
        text: response.message,
        sessionId: response.sessionId,
        usage: response.usage,
        ...(turnFileChanges.length > 0 ? { fileChanges: turnFileChanges } : {}),
      };
    } finally {
      session.activeMcpTurn = undefined;
      session.allowEmptyNativeFinal = false;
    }
  }

  /**
   * Run one Claude Code turn, absorbing recoverable CLI flakiness within the
   * turn's shared recovery budget:
   *
   * - `process_ended`: the CLI died (or exited cleanly) before delivering the
   *   step's result. Respawn and resend the same prompt; the spawn path
   *   resumes the persisted transcript when possible and otherwise falls back
   *   to reseeding from `resumeFallbackPrompt`. If the failed attempt had
   *   already applied native file writes, the retry switches to a
   *   non-mutating reconciliation prompt so those edits are never replayed.
   * - `malformed_result`: the CLI answered without final text. The session
   *   process is still alive with full context, so send a corrective nudge.
   *
   * Native file writes observed on failed attempts are merged into the
   * eventual step result so recoveries never drop artifacts. Aborted runs
   * never retry; exhausted budgets rethrow with an actionable message.
   */
  private async executeStepWithRecovery(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    promptImages: readonly ClaudeCodePromptImage[],
    recoveryBudget: { remaining: number },
  ): Promise<ClaudeCodeStepResult> {
    let currentPrompt = prompt;
    let currentPromptImages = promptImages;
    const failedAttemptFileChanges: FileChangeRecord[] = [];
    const failedAttemptFileChangeKeys = new Set<string>();
    const failedAttemptMcpCalls: ClaudeCodeMcpCallRecord[] = [];
    for (;;) {
      try {
        const result = await this.executeStep(
          session,
          request,
          effectiveSystemPrompt,
          currentPrompt,
          currentPromptImages,
          failedAttemptFileChanges,
          failedAttemptMcpCalls,
        );
        if (failedAttemptFileChanges.length === 0) {
          return result;
        }
        mergeFileChanges(
          failedAttemptFileChanges,
          failedAttemptFileChangeKeys,
          result.fileChanges,
        );
        return { ...result, fileChanges: failedAttemptFileChanges };
      } catch (error) {
        if (request.abortSignal?.aborted) {
          throw error;
        }
        if (error instanceof ClaudeCodeLoginRequiredError) {
          // Authentication cannot recover by replaying the prompt. Drop the
          // child so the first turn after /login starts a fresh CLI process
          // that reads the new credentials.
          this.resetStreamingProcess(request.sessionKey, session);
          throw error;
        }
        const recoverable = asRecoverableStepError(error);
        const hasPossibleSideEffects = Boolean(
          recoverable &&
            (recoverable.fileChanges.length > 0 ||
              recoverable.mcpCalls.length > 0),
        );
        // A normal refusal/overload can retry the configured model and then
        // fall back. Once any tool call started, the same prompt is never
        // replayed: even an aborted/errored call may already have committed.
        if (
          !hasPossibleSideEffects &&
          this.applyFableFallbackPolicy(session, request, error)
        ) {
          continue;
        }
        if (!recoverable) {
          throw error;
        }
        mergeFileChanges(
          failedAttemptFileChanges,
          failedAttemptFileChangeKeys,
          recoverable.fileChanges,
        );
        mergeMcpCalls(failedAttemptMcpCalls, recoverable.mcpCalls);
        if (recoveryBudget.remaining <= 0) {
          throw withStepRecoveryExhausted(error);
        }
        recoveryBudget.remaining -= 1;
        if (recoverable instanceof ClaudeCodeProcessEndedError) {
          this.resetStreamingProcess(request.sessionKey, session);
          // Never blind-replay a prompt whose attempt already mutated files:
          // the respawned session must reconcile, not redo. (Bash-side writes
          // stay invisible to this guard — the stream only names file-tool
          // paths.)
          if (
            failedAttemptFileChanges.length > 0 ||
            failedAttemptMcpCalls.length > 0
          ) {
            currentPrompt = buildSideEffectReconciliationPrompt(
              failedAttemptFileChanges,
              failedAttemptMcpCalls,
            );
            currentPromptImages = [];
          }
          continue;
        }
        currentPrompt = hasPossibleSideEffects
          ? buildSideEffectReconciliationPrompt(
              failedAttemptFileChanges,
              failedAttemptMcpCalls,
            )
          : buildResultRetryPrompt();
        currentPromptImages = [];
      }
    }
  }

  /**
   * Fable refusal/overload policy, mirroring the stella engine's safety
   * swap: give the configured fable model SAFETY_ABORT_FABLE_ATTEMPTS
   * consecutive attempts at the failing step, then switch the REST OF THIS
   * TURN to CLAUDE_CODE_FALLBACK_MODEL via `session.modelOverride` (the
   * next ensureStreamingProcess sees the config change and restarts on the
   * fallback with --resume, keeping the CLI conversation). executeTurn
   * clears the override at every turn start, so each new user message
   * reattempts fable. Returns true when the caller should resend the same
   * prompt; false when the policy doesn't apply (including a failure on the
   * fallback itself) and the error should propagate.
   */
  private applyFableFallbackPolicy(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    error: unknown,
  ): boolean {
    if (session.modelOverride) return false;
    const modelName = parseClaudeCodeModel(request.modelId);
    if (!modelName || !/\bfable\b/.test(modelName)) return false;
    const message = error instanceof Error ? error.message : "";
    if (!isClaudeCodeModelRefusalOrOverloadError(message)) return false;

    session.fableSafetyFailures = (session.fableSafetyFailures ?? 0) + 1;
    const prettyFrom = formatClaudeCodeResolvedModel(modelName);
    if (session.fableSafetyFailures < SAFETY_ABORT_FABLE_ATTEMPTS) {
      request.onStatusChange?.({
        state: "running",
        text:
          `${prettyFrom} refused this request — retrying ` +
          `(attempt ${session.fableSafetyFailures + 1} of ` +
          `${SAFETY_ABORT_FABLE_ATTEMPTS})`,
      });
      return true;
    }

    session.modelOverride = CLAUDE_CODE_FALLBACK_MODEL;
    const prettyTo = formatClaudeCodeResolvedModel(CLAUDE_CODE_FALLBACK_MODEL);
    if (!session.modelFallbackNotified) {
      session.modelFallbackNotified = true;
      request.onStatusChange?.({
        state: "model-fallback",
        text:
          `${prettyFrom} failed ${SAFETY_ABORT_FABLE_ATTEMPTS} attempts ` +
          `(refusal/overload), so this turn switched to ${prettyTo}. ` +
          `${prettyFrom} will be retried on your next message.`,
      });
    }
    return true;
  }

  private async executeStep(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    promptImages: readonly ClaudeCodePromptImage[],
    observedMutations: readonly FileChangeRecord[] = [],
    observedMcpCalls: readonly ClaudeCodeMcpCallRecord[] = [],
  ): Promise<ClaudeCodeStepResult> {
    return await this.executeStepWithMode(
      session,
      request,
      effectiveSystemPrompt,
      prompt,
      session.resumeReady,
      true,
      promptImages,
      observedMutations,
      observedMcpCalls,
    );
  }

  /**
   * `observedMutations` carries native file writes already applied by
   * earlier attempts of THIS step. Every reseed path below (missing resume,
   * compaction loop) must honor it: once mutations are known, the reseed
   * prompt is the reconciliation prompt — never `resumeFallbackPrompt`,
   * whose history+request would replay the mutations on the fresh session.
   */
  private async executeStepWithMode(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    useResume: boolean,
    allowCompactionLoopRestart = true,
    promptImages: readonly ClaudeCodePromptImage[] = [],
    observedMutations: readonly FileChangeRecord[] = [],
    observedMcpCalls: readonly ClaudeCodeMcpCallRecord[] = [],
  ): Promise<ClaudeCodeStepResult> {
    // Reseeded sessions have no transcript, so a mutation-guarded reseed
    // embeds the would-be seed prompt as reference-only context.
    const buildReseedPrompt = (
      mutations: readonly FileChangeRecord[],
      mcpCalls: readonly ClaudeCodeMcpCallRecord[],
    ): string =>
      mutations.length > 0 || mcpCalls.length > 0
        ? buildSideEffectReconciliationPrompt(
            mutations,
            mcpCalls,
            request.resumeFallbackPrompt ?? prompt,
          )
        : (request.resumeFallbackPrompt ?? prompt);
    try {
      const processState = await this.ensureStreamingProcess(
        session,
        request,
        effectiveSystemPrompt,
        useResume,
      );
      return await this.sendStreamingPrompt(
        session,
        processState,
        request,
        prompt,
        promptImages,
      );
    } catch (error) {
      const message = normalizeErrorMessage(error);
      if (!useResume && isSessionAlreadyInUseError(message)) {
        this.resetStreamingProcess(request.sessionKey, session);
        return await this.executeStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          prompt,
          true,
          allowCompactionLoopRestart,
          promptImages,
          observedMutations,
          observedMcpCalls,
        );
      }
      if (useResume && isMissingResumeSessionError(message)) {
        this.resetStreamingProcess(request.sessionKey, session);
        session.sessionId = crypto.randomUUID();
        session.turnCount = 0;
        session.resumeReady = false;
        return await this.executeStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          buildReseedPrompt(observedMutations, observedMcpCalls),
          false,
          allowCompactionLoopRestart,
          promptImages,
          observedMutations,
          observedMcpCalls,
        );
      }
      if (
        allowCompactionLoopRestart &&
        error instanceof ClaudeCodeCompactionLoopError
      ) {
        // The session context can no longer fit and Claude Code keeps
        // re-compacting. Abandon the CLI conversation and restart the turn on
        // a fresh session seeded from the checkpoint-compacted Stella
        // history — or, if this or an earlier attempt already applied native
        // file writes, from the reconciliation prompt so they never replay.
        // The caller persists the fresh session id at turn end, replacing
        // the looping one. At most once per step, so a fresh session that
        // still loops fails loudly instead of cycling.
        const mutations = [...observedMutations];
        const mutationKeys = new Set(mutations.map(fileChangeDedupeKey));
        mergeFileChanges(mutations, mutationKeys, error.fileChanges);
        const mcpCalls = [...observedMcpCalls];
        mergeMcpCalls(mcpCalls, error.mcpCalls);
        this.resetStreamingProcess(request.sessionKey, session);
        session.sessionId = crypto.randomUUID();
        session.turnCount = 0;
        session.resumeReady = false;
        const result = await this.executeStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          buildReseedPrompt(mutations, mcpCalls),
          false,
          false,
          promptImages,
          mutations,
          mcpCalls,
        );
        if (error.fileChanges.length === 0) {
          return result;
        }
        // Keep the interrupted attempt's writes on the step result.
        const combined = [...error.fileChanges];
        const combinedKeys = new Set(combined.map(fileChangeDedupeKey));
        mergeFileChanges(combined, combinedKeys, result.fileChanges);
        return { ...result, fileChanges: combined };
      }
      throw error;
    }
  }

  private buildClaudeCodeArgs(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    useResume: boolean,
    mcpHost?: ClaudeCodeToolMcpHost,
  ): string[] {
    // A turn-scoped fallback override (fable exhausted its attempts) beats
    // the configured model; executeTurn clears it at every turn start.
    const modelName =
      session.modelOverride ?? parseClaudeCodeModel(request.modelId);
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--include-hook-events",
      "--settings",
      CLAUDE_CODE_HOOK_SETTINGS,
    ];
    if (!request.vanilla) {
      if (!mcpHost || !session.mcpConfigPath) {
        throw new Error("Claude Code native tool host is unavailable.");
      }
      // Native takeover: Claude owns the tool loop. Its built-ins and all
      // ambient/user MCP servers remain disabled; only this run-private,
      // token-authenticated Stella server is visible.
      const allowedStellaTools = request.tools
        .map((tool) => `mcp__stella__${tool.name}`)
        .join(",");
      args.push(
        "--strict-mcp-config",
        "--mcp-config",
        session.mcpConfigPath,
        "--disable-slash-commands",
        "--tools",
        "mcp__stella__*",
        "--allowedTools",
        allowedStellaTools,
      );
    }
    if (effectiveSystemPrompt.trim()) {
      args.push("--system-prompt", effectiveSystemPrompt.trim());
    }
    if (modelName) {
      args.push("--model", modelName);
    }
    if (useResume) {
      args.push("--resume", session.sessionId);
    }
    return args;
  }

  private buildProcessLaunchConfig(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    mcpHost?: ClaudeCodeToolMcpHost,
  ): string {
    return JSON.stringify([
      session.modelOverride ?? parseClaudeCodeModel(request.modelId) ?? "",
      request.effortLevel?.trim() ?? "",
      Boolean(request.vanilla),
      mcpHost?.toolCatalogHash ?? "",
      effectiveSystemPrompt.trim(),
      request.autoCompactWindowTokens ?? null,
      request.autoCompactTriggerPct ?? null,
      request.cliBridgeSocketPath ?? "",
    ]);
  }

  private async ensureMcpHost(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
  ): Promise<ClaudeCodeToolMcpHost | undefined> {
    if (request.vanilla) {
      if (session.mcpHost) {
        await session.mcpHost.close().catch(() => undefined);
        session.mcpHost = undefined;
        session.mcpToolCatalogKey = undefined;
        session.mcpConfigPath = undefined;
      }
      return undefined;
    }
    const catalogKey = crypto
      .createHash("sha256")
      .update(JSON.stringify(request.tools))
      .digest("hex");
    if (session.mcpHost && session.mcpToolCatalogKey === catalogKey) {
      return session.mcpHost;
    }
    // A process spawned against the old immutable catalog cannot be pointed
    // at a replacement listener in place. Stop it before rotating the host;
    // the caller resumes the same Claude conversation on the new process.
    this.resetStreamingProcess(request.sessionKey, session);
    if (session.mcpHost) {
      await session.mcpHost.close().catch(() => undefined);
    }
    session.mcpHost = await createClaudeCodeToolMcpHost({
      tools: request.tools,
      identityScope: request.sessionKey,
      getActiveTurn: () => session.activeMcpTurn,
    });
    session.mcpToolCatalogKey = catalogKey;
    session.mcpConfigPath = path.join(
      ensureArtifactDir(session),
      "claude-code-mcp.json",
    );
    fs.writeFileSync(
      session.mcpConfigPath,
      JSON.stringify({
        mcpServers: { stella: session.mcpHost.mcpServerConfig },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    // writeFile's mode does not tighten an existing path after host rotation.
    fs.chmodSync(session.mcpConfigPath, 0o600);
    return session.mcpHost;
  }

  private async ensureStreamingProcess(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    useResume: boolean,
  ): Promise<ClaudeCodeStreamingProcess> {
    const mcpHost = await this.ensureMcpHost(session, request);
    const launchConfig = this.buildProcessLaunchConfig(
      session,
      request,
      effectiveSystemPrompt,
      mcpHost,
    );
    if (
      session.process &&
      !session.process.closed &&
      // Dying-process fence: a child that has been signaled (`killed` is
      // "signal sent") or already terminated must never take new prompts —
      // a late reuse would write into a process the kill ladder is tearing
      // down. Its exit handler rejects the pendings and clears
      // `session.process`; respawning below (same resume id) is the
      // correct successor.
      !session.process.child.killed &&
      !processIsDead(session.process.child)
    ) {
      if (session.process.launchConfig === launchConfig) {
        return session.process;
      }
      if (session.process.pending.length > 0) {
        // Prompts are still in flight on the old configuration; swapping
        // now would fail them. Keep the process — the next idle step
        // picks the new configuration up.
        return session.process;
      }
      // The request wants a different CLI configuration (the user changed
      // the model / effort mid-session, or the mode flipped). Restart the
      // process; `useResume` continues the same CLI conversation on the
      // new configuration.
      this.resetStreamingProcess(request.sessionKey, session);
    }

    const executablePath = resolveExternalCliPath("claude");
    const effortLevel = request.effortLevel?.trim();
    const childEnv = buildExternalCliChildEnv(executablePath, process.env, {
      ...(request.cliBridgeSocketPath
        ? { cliBridgeSocketPath: request.cliBridgeSocketPath }
        : {}),
    });
    if (effortLevel) {
      childEnv.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
    }
    if (
      Number.isFinite(request.autoCompactWindowTokens) &&
      (request.autoCompactWindowTokens ?? 0) > 0
    ) {
      childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
        Math.floor(request.autoCompactWindowTokens!),
      );
    }
    if (
      Number.isFinite(request.autoCompactTriggerPct) &&
      (request.autoCompactTriggerPct ?? 0) > 0
    ) {
      childEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(
        Math.min(100, Math.max(1, Math.floor(request.autoCompactTriggerPct!))),
      );
    }
    const child = spawn(
      executablePath,
      this.buildClaudeCodeArgs(
        session,
        request,
        effectiveSystemPrompt,
        useResume,
        mcpHost,
      ),
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: request.cwd,
        env: childEnv,
      },
    );
    const processState: ClaudeCodeStreamingProcess = {
      child,
      stdoutBuffer: "",
      stdoutDecoder: new StringDecoder("utf8"),
      stderrText: "",
      finalSessionId: session.sessionId,
      pending: [],
      closed: false,
      compacting: false,
      compactionCount: 0,
      launchConfig,
    };
    session.process = processState;
    this.activeProcesses.set(request.sessionKey, child);

    const refreshPendingIdleTimers = (hasOutput = false) => {
      for (const pending of processState.pending) {
        if (hasOutput) pending.hasOutput = true;
        this.refreshPendingIdleTimer(processState, pending);
      }
    };

    const consumeStdout = (flush = false) => {
      const segments = flush
        ? [processState.stdoutBuffer]
        : processState.stdoutBuffer.split("\n");
      const completeSegments = flush ? segments : segments.slice(0, -1);
      processState.stdoutBuffer = flush
        ? ""
        : (segments[segments.length - 1] ?? "");
      for (const segment of completeSegments) {
        const line = segment.trim();
        if (!line) {
          continue;
        }
        const parsedLine = parseStreamJsonLine(line);
        if (!parsedLine) {
          continue;
        }
        if (
          typeof parsedLine.session_id === "string" &&
          parsedLine.session_id.trim()
        ) {
          processState.finalSessionId = parsedLine.session_id.trim();
          session.sessionId = processState.finalSessionId;
          session.resumeReady = true;
        }
        // The init event names the model the CLI actually resolved the
        // requested alias to (e.g. default -> claude-opus-4-8[1m]).
        if (
          parsedLine.type === "system" &&
          parsedLine.subtype === "init" &&
          request.onProtocolInit
        ) {
          request.onProtocolInit({
            tools: Array.isArray(parsedLine.tools)
              ? parsedLine.tools.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [],
            mcpServers: Array.isArray(parsedLine.mcp_servers)
              ? parsedLine.mcp_servers.map((entry) => {
                  const value = asObject(entry);
                  return {
                    ...(typeof value?.name === "string"
                      ? { name: value.name }
                      : {}),
                    ...(typeof value?.status === "string"
                      ? { status: value.status }
                      : {}),
                  };
                })
              : [],
          });
        }
        if (
          parsedLine.type === "system" &&
          parsedLine.subtype === "init" &&
          typeof parsedLine.model === "string" &&
          request.stellaAppDir
        ) {
          void recordClaudeCodeResolvedModel(
            request.stellaAppDir,
            parseClaudeCodeModel(request.modelId) ?? "default",
            parsedLine.model,
          );
        }
        const status = getClaudeCodeStatusChangeFromStreamEvent(parsedLine);
        if (status) {
          // Count discrete compactions (compacting -> running transitions),
          // not every compaction-related stream event.
          if (status.state === "compacting" && !processState.compacting) {
            processState.compacting = true;
            processState.compactionCount += 1;
            if (processState.compactionCount > MAX_COMPACTIONS_PER_TURN) {
              this.failCompactionLoop(
                request.sessionKey,
                session,
                processState,
              );
              return;
            }
          } else if (status.state === "running") {
            processState.compacting = false;
          }
        }
        // The CLI switched the session to the --fallback-model (configured
        // model overloaded). The switch is sticky for the session, so
        // surface it once as a heads-up toast (latch on the session so we
        // don't spam).
        const modelFallback =
          getClaudeCodeModelFallbackFromStreamEvent(parsedLine);
        const current = processState.pending[0];
        if (current) {
          const modelRound = getClaudeCodeModelRoundFromStreamEvent(parsedLine);
          if (modelRound) {
            try {
              current.request.onModelRound?.(modelRound);
            } catch {
              // Diagnostic observers must never disrupt the engine stream.
            }
          }
          observeFinalizedClaudeToolUses(
            parsedLine,
            session.activeNativeToolUseCorrelator?.observe,
          );
          // Record the stop_reason verdict BEFORE the MCP gate can consult it,
          // and shout when a tool call's arguments were cut mid-value. The
          // gate below rejects the call when it wins the race with the CLI's
          // HTTP dispatch; this notice is what makes the loss visible instead
          // of shipping half an instruction in silence.
          const truncatedToolUse =
            session.activeNativeToolUseCorrelator?.observeAssistantMessage(
              parsedLine,
            );
          if (truncatedToolUse) {
            current.request.onStatusChange?.({
              state: "running",
              text: `⚠ Truncated tool call — ${describeClaudeToolUseTruncation(truncatedToolUse)} Stella blocked or flagged it; the instruction was NOT delivered in full.`,
            });
          }
          session.activeNativeToolUseCorrelator?.observeStreamEvent(parsedLine);
          if (
            updateClaudeCodeNativeToolActivity(
              parsedLine,
              current.activeNativeToolUseIds,
              current.request.onNativeToolStart,
            )
          ) {
            this.refreshPendingIdleTimer(processState, current);
          }
          if (status) {
            current.request.onStatusChange?.(status);
          }
          if (modelFallback && !session.modelFallbackNotified) {
            session.modelFallbackNotified = true;
            current.request.onStatusChange?.({
              state: "model-fallback",
              text: modelFallback.text,
            });
          }
          current.emitStreamDelta(parsedLine);
          const nativeFileChanges =
            collectClaudeCodeNativeFileChanges(parsedLine);
          if (nativeFileChanges.length > 0) {
            current.fileChanges.push(...nativeFileChanges);
          }
        }
        if (parsedLine.type === "result") {
          const completed = processState.pending.shift();
          if (!completed) {
            continue;
          }
          this.detachAbortListener(completed);
          try {
            const stepResult = this.parseResultPayload(
              session,
              parsedLine,
              processState.stderrText,
              Boolean(
                !completed.request.vanilla && session.allowEmptyNativeFinal,
              ),
            );
            completed.resolve(
              completed.fileChanges.length > 0
                ? { ...stepResult, fileChanges: completed.fileChanges }
                : stepResult,
            );
          } catch (error) {
            // Carry file writes observed during the failed step so a nudge
            // recovery still reports them on the eventual turn result.
            if (
              error instanceof ClaudeCodeMalformedResultError &&
              completed.fileChanges.length > 0
            ) {
              error.fileChanges.push(...completed.fileChanges);
            }
            if (error instanceof ClaudeCodeMalformedResultError) {
              mergeMcpCalls(error.mcpCalls, completed.mcpCalls);
            }
            completed.reject(error);
          }
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      processState.stdoutBuffer += processState.stdoutDecoder.write(chunk);
      refreshPendingIdleTimers(true);
      consumeStdout(false);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      refreshPendingIdleTimers(true);
      if (processState.stderrText.length >= MAX_STDERR_CAPTURE) return;
      processState.stderrText += chunk.toString("utf8");
      if (processState.stderrText.length > MAX_STDERR_CAPTURE) {
        processState.stderrText = processState.stderrText.slice(
          0,
          MAX_STDERR_CAPTURE,
        );
      }
    });

    child.once("error", (error) => {
      const wrapped = new Error(
        `Failed to start Claude Code: ${normalizeErrorMessage(error)}`,
      );
      processState.closed = true;
      const ownsSessionProcess = session.process === processState;
      if (ownsSessionProcess) {
        resetSessionMcpClients(session, wrapped);
        session.process = undefined;
      }
      // A restart may already have registered a replacement child under this
      // session key; only remove OUR child from tracking.
      if (this.activeProcesses.get(request.sessionKey) === child) {
        this.activeProcesses.delete(request.sessionKey);
      }
      for (const pending of processState.pending.splice(0)) {
        this.detachAbortListener(pending);
        pending.reject(
          new ClaudeCodeProcessEndedError(
            wrapped.message,
            null,
            pending.fileChanges,
            pending.mcpCalls,
          ),
        );
      }
    });

    child.once("close", (code) => {
      consumeStdout(true);
      processState.closed = true;
      const ownsSessionProcess = session.process === processState;
      if (ownsSessionProcess) {
        resetSessionMcpClients(
          session,
          new Error("Claude Code process exited."),
        );
        session.process = undefined;
      }
      // A restart may already have registered a replacement child under this
      // session key; only remove OUR child from tracking.
      if (this.activeProcesses.get(request.sessionKey) === child) {
        this.activeProcesses.delete(request.sessionKey);
      }
      const message =
        processState.stderrText.trim() ||
        `Claude Code exited with code ${code ?? "unknown"} before returning a result.`;
      for (const pending of processState.pending.splice(0)) {
        this.detachAbortListener(pending);
        pending.reject(
          pending.request.abortSignal?.aborted
            ? new Error("Claude Code run aborted.")
            : new ClaudeCodeProcessEndedError(
                message,
                code,
                pending.fileChanges,
                pending.mcpCalls,
              ),
        );
      }
    });

    if (mcpHost && request.tools.some((tool) => tool.name === "image_gen")) {
      await mcpHost.waitForClientReady(request.abortSignal);
    }
    return processState;
  }

  private async sendStreamingPrompt(
    session: SessionState,
    processState: ClaudeCodeStreamingProcess,
    request: ClaudeCodeTurnRequest,
    prompt: string,
    promptImages: readonly ClaudeCodePromptImage[] = [],
  ): Promise<ClaudeCodeStepResult> {
    if (processState.closed || processState.child.stdin.destroyed) {
      throw new ClaudeCodeProcessEndedError("Claude Code stream is closed.");
    }
    return await new Promise<ClaudeCodeStepResult>((resolve, reject) => {
      const pending: PendingClaudeCodePrompt = {
        request,
        resolve,
        reject,
        emitStreamDelta: createClaudeCodeStreamEmitter(request.onStream),
        fileChanges: [],
        mcpCalls: [],
        activeNativeToolUseIds: new Set(),
      };
      this.refreshPendingIdleTimer(processState, pending);
      if (request.abortSignal) {
        pending.abortListener = () => {
          resetSessionMcpClients(
            session,
            request.abortSignal?.reason ??
              new Error("Claude Code run aborted."),
          );
          abortProcess(processState.child);
        };
        if (request.abortSignal.aborted) {
          pending.abortListener();
        } else {
          request.abortSignal.addEventListener("abort", pending.abortListener, {
            once: true,
          });
        }
      }
      processState.pending.push(pending);
      // Claude Code's stream-json input accepts Anthropic image content
      // blocks directly, so screenshots reach vision without enabling any
      // Claude-native file or shell tools outside Stella's tool boundary.
      const content =
        promptImages.length > 0
          ? [
              { type: "text", text: prompt },
              ...promptImages.map((image) => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mimeType,
                  data: image.data,
                },
              })),
            ]
          : prompt;
      const payload = JSON.stringify({
        type: "user",
        session_id: session.sessionId,
        message: {
          role: "user",
          content,
        },
        parent_tool_use_id: null,
      });
      processState.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }
        const index = processState.pending.indexOf(pending);
        if (index >= 0) {
          processState.pending.splice(index, 1);
        }
        this.detachAbortListener(pending);
        // A failed stdin write means the process died under us (EPIPE);
        // classify it as process-ended so the step recovery can respawn.
        reject(
          new ClaudeCodeProcessEndedError(
            `Failed to write Claude Code prompt: ${normalizeErrorMessage(error)}`,
            null,
            pending.fileChanges,
            pending.mcpCalls,
          ),
        );
      });
    });
  }

  private detachAbortListener(pending: PendingClaudeCodePrompt): void {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
      pending.idleTimer = undefined;
    }
    if (pending.abortListener && pending.request.abortSignal) {
      pending.request.abortSignal.removeEventListener(
        "abort",
        pending.abortListener,
      );
    }
  }

  private refreshPendingIdleTimer(
    processState: ClaudeCodeStreamingProcess,
    pending: PendingClaudeCodePrompt,
  ): void {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
    }
    pending.idleTimer = undefined;
    // Vanilla Claude Code runs native tools inside the CLI. Their stream-json
    // lifecycle is edge-triggered, so a silent Bash/Task invocation is still
    // confirmed live work and must not be mistaken for a dead output stream.
    // We cannot cancel an individual native tool from out here, so instead of
    // disarming entirely (an unresolved tool_use would hang the session
    // forever), arm the watchdog with the much longer tool ceiling.
    const toolsInFlight = pending.activeNativeToolUseIds.size > 0;
    const timeoutMs = toolsInFlight
      ? configuredTimeoutMs(
          "STELLA_CLAUDE_CODE_TOOL_IDLE_TIMEOUT_MS",
          DEFAULT_STEP_TOOL_IDLE_TIMEOUT_MS,
        )
      : pending.hasOutput
        ? configuredTimeoutMs(
            "STELLA_CLAUDE_CODE_IDLE_TIMEOUT_MS",
            DEFAULT_STEP_IDLE_TIMEOUT_MS,
          )
        : configuredTimeoutMs(
            "STELLA_CLAUDE_CODE_STARTUP_IDLE_TIMEOUT_MS",
            DEFAULT_STEP_STARTUP_IDLE_TIMEOUT_MS,
          );
    pending.idleTimer = setTimeout(() => {
      const index = processState.pending.indexOf(pending);
      if (index >= 0) {
        processState.pending.splice(index, 1);
      }
      this.detachAbortListener(pending);
      abortProcess(processState.child);
      pending.reject(
        new Error(
          toolsInFlight
            ? `Claude Code produced no output for ${Math.round(timeoutMs / 1000)}s with ${pending.activeNativeToolUseIds.size} native tool call(s) still unresolved.`
            : `Claude Code did not produce output for ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    pending.idleTimer.unref?.();
  }

  private parseResultPayload(
    session: SessionState,
    parsed: Record<string, unknown>,
    stderrText: string,
    allowEmptyFinal = false,
  ): ClaudeCodeStepResult {
    let resultError: string | undefined;
    if (parsed.is_error === true) {
      const parsedError =
        (typeof parsed.result === "string" && parsed.result.trim()) ||
        (typeof parsed.error === "string" && parsed.error.trim()) ||
        textArrayMessage(parsed.errors) ||
        stderrText.trim() ||
        "";
      resultError = parsedError || "Claude Code reported an error.";
    }
    if (resultError) {
      if (isClaudeCodeLoginRequiredMessage(resultError)) {
        throw new ClaudeCodeLoginRequiredError();
      }
      throw new ClaudeCodeMalformedResultError(resultError, "result_error");
    }
    const usageRaw = parsed.usage as Record<string, unknown> | undefined;
    const inputTokens = asNumber(
      usageRaw?.input_tokens ?? usageRaw?.inputTokens,
    );
    const outputTokens = asNumber(
      usageRaw?.output_tokens ?? usageRaw?.outputTokens,
    );
    const usage =
      inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined;
    const message =
      typeof parsed.result === "string" ? parsed.result.trim() : "";
    if (!message && !allowEmptyFinal) {
      throw new ClaudeCodeMalformedResultError(
        stderrText.trim() || "Claude Code returned an empty result.",
        "empty_result",
      );
    }
    session.turnCount += 1;
    session.lastUsedAt = Date.now();
    return {
      message,
      sessionId: session.sessionId,
      usage,
    };
  }

  /**
   * Kill a session process stuck in a compaction loop and fail its in-flight
   * prompts with a recognizable error so `executeStepWithMode` can
   * restart the turn on a fresh session seeded from the checkpoint history.
   */
  private failCompactionLoop(
    sessionKey: string,
    session: SessionState,
    processState: ClaudeCodeStreamingProcess,
  ): void {
    processState.closed = true;
    if (session.process === processState) {
      session.process = undefined;
    }
    if (this.activeProcesses.get(sessionKey) === processState.child) {
      this.activeProcesses.delete(sessionKey);
    }
    const failed = processState.pending.splice(0);
    resetSessionMcpClients(session, new ClaudeCodeCompactionLoopError());
    killProcess(processState.child);
    for (const pending of failed) {
      this.detachAbortListener(pending);
      // Typed and file-change-aware: the reseed path must know which native
      // writes this step already applied so it reconciles instead of
      // replaying them, and reports them on the eventual result.
      pending.reject(
        new ClaudeCodeCompactionLoopError(
          pending.fileChanges,
          pending.mcpCalls,
        ),
      );
    }
  }

  private resetStreamingProcess(
    sessionKey: string,
    session: SessionState,
  ): void {
    if (!session.process) {
      return;
    }
    const child = session.process.child;
    resetSessionMcpClients(
      session,
      new Error("Claude Code process is restarting."),
    );
    killProcess(child);
    session.process = undefined;
    if (this.activeProcesses.get(sessionKey) === child) {
      this.activeProcesses.delete(sessionKey);
    }
  }
}

const runtime = new ClaudeCodeSessionRuntime();

export const isClaudeCodeModel = (modelId: string): boolean =>
  modelId.trim().startsWith(CLAUDE_CODE_MODEL_PREFIX);

export const runClaudeCodeTurn = async (
  request: ClaudeCodeTurnRequest,
): Promise<ClaudeCodeTurnResult> => await runtime.runTurn(request);

/** Diagnostic/test hook: is a live CLI process tracked for this session key? */
export const claudeCodeSessionHasActiveProcess = (
  sessionKey: string,
): boolean => runtime.hasActiveProcess(sessionKey);

export const closeClaudeCodeSessionWhenIdle = (sessionKey: string): void => {
  runtime.closeSessionWhenIdle(sessionKey);
};

export const scheduleClaudeCodeSessionCloseWhenIdle = (
  sessionKey: string,
  timeoutMs: number,
): void => {
  runtime.scheduleSessionCloseWhenIdle(sessionKey, timeoutMs);
};

export const listClaudeCodeModels = async (
  auth?: { apiKey?: string | null; oauthToken?: string | null },
  stellaAppDir?: string,
): Promise<{ models: ClaudeCodeModelOption[] }> => {
  const models = new Map<string, ClaudeCodeModelOption>();
  const resolvedModels = stellaAppDir
    ? readClaudeCodeResolvedModels(stellaAppDir)
    : {};
  for (const alias of CLAUDE_CODE_ALIASES) {
    const labels = CLAUDE_CODE_ALIAS_LABELS[alias];
    const resolved = resolvedModels[alias];
    models.set(alias, {
      id: alias,
      // Show the CLI-reported real model behind the alias when we've seen
      // one (e.g. "Default · Opus 4.8 (1M context)").
      displayName: resolved
        ? `${labels.displayName} · ${formatClaudeCodeResolvedModel(resolved)}`
        : labels.displayName,
      description: labels.description,
      source: "alias",
    });
  }

  const apiKey = auth?.apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  const oauthToken =
    auth?.oauthToken?.trim() || process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (!apiKey && !oauthToken) return { models: [...models.values()] };

  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "anthropic-version": "2023-06-01",
        ...(oauthToken
          ? {
              authorization: `Bearer ${oauthToken}`,
              "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
              "anthropic-dangerous-direct-browser-access": "true",
              "user-agent": "claude-cli/2.1.146",
            }
          : { "x-api-key": apiKey ?? "" }),
      },
    });
    if (!response.ok) return { models: [...models.values()] };

    const parsed = (await response.json()) as {
      data?: Array<{ id?: unknown; display_name?: unknown }>;
    };
    for (const model of parsed.data ?? []) {
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      const id = model.id.trim();
      models.set(id, {
        id,
        displayName:
          typeof model.display_name === "string" && model.display_name.trim()
            ? model.display_name.trim()
            : id,
        source: "anthropic",
      });
    }
  } catch {
    return { models: [...models.values()] };
  }
  return { models: [...models.values()] };
};

export const shutdownClaudeCodeRuntime = (): void => {
  runtime.dispose();
};
