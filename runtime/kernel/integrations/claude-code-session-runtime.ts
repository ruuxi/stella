import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
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
import { SAFETY_ABORT_FABLE_ATTEMPTS } from "../agent-runtime/provider-abort-containment.js";
import type {
  FileChangeKind,
  FileChangeRecord,
} from "../../contracts/file-changes.js";
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
const MAX_TOOL_RESULT_CHARS = 80_000;
const DEFAULT_STEP_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_STEP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
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
 * Recovery budget for flaky step endings, shared across all structured steps
 * of one Stella turn. Covers two observed CLI failure shapes:
 *
 * - The CLI process ends (often cleanly, exit code 0) while a step prompt is
 *   still in flight, without ever emitting its `result` line. Recovery
 *   respawns the CLI and resends the same step prompt — `--resume` restores
 *   the on-disk transcript when one exists, and the missing-resume fallback
 *   reseeds from the checkpoint history otherwise.
 * - The step's `result` arrives but carries no usable payload (an empty
 *   result, or a decision JSON missing required fields — the CLI sometimes
 *   emits a truncated `StructuredOutput` like `{"type":"tool_request"}`).
 *   Recovery nudges the still-live session to restate the decision.
 *
 * Past the budget the turn fails to the caller with an actionable message.
 */
const MAX_STEP_RECOVERIES_PER_TURN = 2;

type ClaudeCodePromptImage = Awaited<
  ReturnType<typeof extractAttachImageBlocks>
>["images"][number];

export type ClaudeCodeToolResultPrompt = {
  text: string;
  images: ClaudeCodePromptImage[];
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

  constructor(
    message: string,
    exitCode: number | null = null,
    fileChanges: FileChangeRecord[] = [],
  ) {
    super(message);
    this.name = "ClaudeCodeProcessEndedError";
    this.exitCode = exitCode;
    this.fileChanges = fileChanges;
  }
}

/**
 * The step completed but its `result` payload was unusable: empty result
 * text, or no parseable Stella decision (takeover mode).
 */
export class ClaudeCodeMalformedResultError extends Error {
  readonly kind: "empty_result" | "invalid_decision";
  /** Native-tool file writes observed on the failed step (vanilla mode). */
  readonly fileChanges: FileChangeRecord[];

  constructor(
    message: string,
    kind: "empty_result" | "invalid_decision",
    fileChanges: FileChangeRecord[] = [],
  ) {
    super(message);
    this.name = "ClaudeCodeMalformedResultError";
    this.kind = kind;
    this.fileChanges = fileChanges;
  }
}

/**
 * The CLI re-compacted past `MAX_COMPACTIONS_PER_TURN` within one Stella
 * turn. Handled inside `executeStructuredStepWithMode` (fresh-session
 * reseed), NOT by the step-recovery budget — a reseeded session that loops
 * again fails loudly. Carries the failed step's observed native file writes
 * so the reseed can reconcile instead of replaying them.
 */
export class ClaudeCodeCompactionLoopError extends Error {
  readonly fileChanges: FileChangeRecord[];

  constructor(fileChanges: FileChangeRecord[] = []) {
    super(CLAUDE_CODE_COMPACTION_LOOP_MESSAGE);
    this.name = "ClaudeCodeCompactionLoopError";
    this.fileChanges = fileChanges;
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
  referenceContext?: string,
): string => {
  const paths = [...new Set(mutations.map((change) => change.path))];
  return [
    "The previous step was interrupted after some of its file operations had already been applied.",
    paths.length > 0
      ? [
          "File operations were already applied to:",
          ...paths.map((p) => `- ${p}`),
        ].join("\n")
      : "",
    "Do NOT redo, repeat, or revert any file operations from that step.",
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

const buildDecisionRetryPrompt = (vanilla: boolean): string =>
  vanilla
    ? "Your previous reply produced no result text. Provide your complete final answer to the pending request now."
    : [
        "Your previous reply did not contain a valid Stella decision payload, so it was discarded.",
        "Respond with JSON only, in exactly one of these forms:",
        '{"type":"tool_request","toolName":"<tool>","args":{...}} to run a Stella tool, or',
        '{"type":"final","message":"<your complete answer>"} when you are done.',
        "Restate your full next step or final answer now.",
      ].join("\n");

const withStepRecoveryExhausted = (error: unknown): Error =>
  new Error(
    `${normalizeErrorMessage(error)} Stella retried ${MAX_STEP_RECOVERIES_PER_TURN} time(s) but Claude Code kept ending the step without a usable result. Check the \`claude\` CLI health (\`claude --version\`, login status), then retry the request.`,
  );

const buildClaudeCodeHookSettings = (): string => {
  const command = `"${process.execPath}" -e ""`;
  return JSON.stringify({
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

export type ClaudeCodeDecision =
  | {
      type: "final";
      message: string;
    }
  | {
      type: "tool_request";
      toolName: string;
      args: Record<string, unknown>;
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
   * system prompt, no structured decision schema. `tools`/`executeTool` are
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
  onStream?: (chunk: string) => void;
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

type StructuredStepResult = {
  action: ClaudeCodeDecision;
  sessionId: string;
  usage?: ClaudeUsage;
  /** Native-tool file writes observed during this step (vanilla mode). */
  fileChanges?: FileChangeRecord[];
};

type PendingStructuredPrompt = {
  request: ClaudeCodeTurnRequest;
  resolve: (value: StructuredStepResult) => void;
  reject: (reason?: unknown) => void;
  emitStreamDelta: (event: Record<string, unknown>) => void;
  /** Accumulates native-tool file writes seen while this prompt streams. */
  fileChanges: FileChangeRecord[];
  abortListener?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasOutput?: boolean;
};

type ClaudeCodeStreamingProcess = {
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrText: string;
  finalSessionId: string;
  pending: PendingStructuredPrompt[];
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

const killProcess = (child: ChildProcessWithoutNullStreams) => {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Process may have already exited.
  }

  const sigkillTimer = setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may have already exited.
      }
    }
  }, SIGKILL_TIMEOUT_MS);

  child.once("exit", () => clearTimeout(sigkillTimer));
};

const abortProcess = (child: ChildProcessWithoutNullStreams) => {
  if (child.killed || child.exitCode !== null) return;
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

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const trimForPrompt = (
  value: string,
  maxChars = MAX_TOOL_RESULT_CHARS,
): string =>
  value.length > maxChars
    ? `${value.slice(0, maxChars)}\n\n[Truncated by Stella]`
    : value;

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

export const buildToolResultPrompt = async (args: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: ToolResult;
}): Promise<ClaudeCodeToolResultPrompt> => {
  const rawResultText = stringifyUnknown(args.toolResult.result);
  const { text: forwardedResultText, images } =
    // The Claude Code engine runs on Anthropic; resize tool-result
    // screenshots to Anthropic's high-resolution-tier caps (2576px).
    await extractAttachImageBlocks(rawResultText, { provider: "anthropic" });
  const serializedResult = trimForPrompt(
    stringifyUnknown({
      result: forwardedResultText || args.toolResult.result,
      details: args.toolResult.details,
      error: args.toolResult.error ?? null,
      attachments:
        images.length > 0
          ? images.map((image, index) => ({
              index: index + 1,
              type: image.type,
              mimeType: image.mimeType,
              sizeBytes: Math.round((image.data.length * 3) / 4),
            }))
          : undefined,
    }),
  );
  const text = [
    "A Stella tool request has completed.",
    `Tool call id: ${args.toolCallId}`,
    `Tool name: ${args.toolName}`,
    "Tool arguments:",
    stringifyUnknown(args.toolArgs),
    images.length > 0
      ? [
          "Tool result attachments:",
          ...images.map(
            (image, index) =>
              `- Attachment ${index + 1}: ${image.mimeType}, ${Math.round((image.data.length * 3) / 4 / 1024)}KB`,
          ),
          "The text result below had Stella inline image markers resolved so the next decision can account for attached screenshot output.",
        ].join("\n")
      : "",
    "Tool result:",
    serializedResult,
    "Decide the next step and respond with JSON only.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  return { text, images };
};

const CLAUDE_CODE_RESPONSE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    type: { type: "string", enum: ["final", "tool_request"] },
    message: { type: "string" },
    toolName: { type: "string" },
    args: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["type"],
  additionalProperties: false,
});

export const buildClaudeCodeToolRuntimePrompt = (
  systemPrompt: string | undefined,
  tools: ToolMetadata[],
): string =>
  [
    systemPrompt?.trim() ?? "",
    "Stella Claude Code runtime contract:",
    "Claude Code built-in tools are disabled for this session. Only Stella-hosted tools are available.",
    "Never mention MCP, missing Claude tools, or the raw tool protocol to the user.",
    'Use `{\"type\":\"tool_request\",\"toolName\":\"...\",\"args\":{...}}` when you need a Stella tool.',
    "When you are ready to answer the user, answer normally. Stella also accepts the schema final form if Claude Code emits structured output.",
    'If you call `NoResponse` and do not need to say anything else, return `{\"type\":\"final\",\"message\":\"\"}` on the next turn.',
    "Only request one tool at a time.",
    "Available Stella tools:",
    JSON.stringify(tools, null, 2),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseClaudeCodeDecision = (
  value: unknown,
): ClaudeCodeDecision | null => {
  const record = asObject(value);
  if (!record) return null;
  if (record.type === "final" && typeof record.message === "string") {
    return {
      type: "final",
      message: record.message,
    };
  }
  if (
    record.type === "tool_request" &&
    typeof record.toolName === "string" &&
    asObject(record.args)
  ) {
    return {
      type: "tool_request",
      toolName: record.toolName,
      args: asObject(record.args) ?? {},
    };
  }
  return null;
};

const mergeUsage = (
  left: ClaudeUsage | undefined,
  right: ClaudeUsage | undefined,
): ClaudeUsage | undefined => {
  if (!left && !right) return undefined;
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
  };
};

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

const JSON_STRING_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const isHighSurrogate = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
};

/**
 * Incrementally decodes the `message` string out of a streaming Claude Code
 * "final" decision payload (`{"type":"final","message":"..."}`). Claude Code
 * delivers that payload either as `StructuredOutput` tool-input JSON
 * (`input_json_delta`) or as plain text deltas that ARE the JSON — in both
 * cases the user-visible answer would otherwise not stream at all and pop in
 * whole at result time. Feed raw JSON fragments to `push`; it returns the
 * newly decoded message text (empty until the payload is known to be a final
 * message, and forever for any other payload shape, e.g. tool requests).
 *
 * Field order is tolerated: type-first payloads
 * (`{"type":"final","message":"..."}`) stream the message incrementally,
 * while message-first payloads (`{"message":"...","type":"final"}`) buffer
 * the message and emit it whole once the trailing `type` confirms the
 * payload is a final answer (emitting earlier could leak a tool request's
 * commentary).
 *
 * Decoding handles fragment boundaries that split JSON escape sequences
 * (`\n`, `\uXXXX`) and surrogate pairs: incomplete tails are held back until
 * the next fragment completes them.
 */
export const createClaudeCodeFinalMessageDecoder = () => {
  let raw = "";
  let phase:
    | "detect"
    | "message"
    | "buffered-message"
    | "await-type"
    | "done"
    | "reject" = "detect";
  /** Scan cursor into `raw` once inside the message string. */
  let cursor = 0;
  /** Held-back high surrogate awaiting its low half. */
  let carry = "";
  /** Decoded message held back until a trailing `type` confirms `final`. */
  let buffered = "";

  const FINAL_MESSAGE_PREFIX =
    /^\s*\{\s*"type"\s*:\s*"final"\s*,\s*"message"\s*:\s*"/;
  const TYPE_VALUE = /^\s*\{\s*"type"\s*:\s*"([^"]*)"/;
  const MESSAGE_FIRST_PREFIX = /^\s*\{\s*"message"\s*:\s*"/;
  const TRAILING_TYPE_VALUE = /"type"\s*:\s*"([^"]*)"/;

  /** Decode string content from `cursor`; stops at the closing quote. */
  const decodeStringChunk = (): { text: string; closed: boolean } => {
    let out = "";
    while (cursor < raw.length) {
      const char = raw[cursor]!;
      if (char === '"') {
        return { text: out, closed: true };
      }
      if (char === "\\") {
        const escape = raw[cursor + 1];
        if (escape === undefined) break; // wait for the rest of the escape
        if (escape === "u") {
          const hex = raw.slice(cursor + 2, cursor + 6);
          if (hex.length < 4) break;
          const code = Number.parseInt(hex, 16);
          out += Number.isNaN(code) ? "" : String.fromCharCode(code);
          cursor += 6;
          continue;
        }
        out += JSON_STRING_ESCAPES[escape] ?? escape;
        cursor += 2;
        continue;
      }
      out += char;
      cursor += 1;
    }
    return { text: out, closed: false };
  };

  return {
    push(fragment: string): string {
      if (!fragment || phase === "done" || phase === "reject") return "";
      raw += fragment;
      if (phase === "detect") {
        const typeMatch = TYPE_VALUE.exec(raw);
        if (typeMatch && typeMatch[1] !== "final") {
          phase = "reject";
          raw = "";
          return "";
        }
        const prefixMatch = FINAL_MESSAGE_PREFIX.exec(raw);
        if (prefixMatch) {
          cursor = prefixMatch[0].length;
          phase = "message";
        } else {
          const messageFirstMatch = MESSAGE_FIRST_PREFIX.exec(raw);
          if (!messageFirstMatch) return "";
          cursor = messageFirstMatch[0].length;
          phase = "buffered-message";
        }
      }
      if (phase === "message") {
        const { text, closed } = decodeStringChunk();
        if (closed) {
          phase = "done";
        }
        let out = carry + text;
        carry = "";
        // Never emit a dangling high surrogate; hold it for the low half.
        const last = out.at(-1);
        if (phase === "message" && last && isHighSurrogate(last)) {
          carry = last;
          out = out.slice(0, -1);
        }
        return out;
      }
      if (phase === "buffered-message") {
        const { text, closed } = decodeStringChunk();
        buffered += text;
        if (!closed) return "";
        cursor += 1; // past the closing quote
        phase = "await-type";
      }
      // phase === "await-type": the message string closed before `type`
      // arrived; wait for it to confirm the payload is a final answer.
      const typeMatch = TRAILING_TYPE_VALUE.exec(raw.slice(cursor));
      if (!typeMatch) return "";
      if (typeMatch[1] === "final") {
        phase = "done";
        const out = buffered;
        buffered = "";
        return out;
      }
      phase = "reject";
      buffered = "";
      raw = "";
      return "";
    },
  };
};

/**
 * Per-step stream emitter. Turns raw Claude Code stream-json events into the
 * user-visible text stream:
 *
 * - Natural assistant text deltas pass through, except when a step's visible
 *   text starts with `{`/`[` — that step IS a decision payload, so instead of
 *   suppressing it wholesale the final-message decoder streams its `message`
 *   field (tool requests still emit nothing).
 * - `StructuredOutput` tool-input deltas stream the decoded final `message`
 *   the same way — without this, tool-loop answers never stream and pop in
 *   whole at result time.
 * - Only the FIRST source to produce visible output owns the step: when
 *   Claude streams a natural-text answer and then restates it as structured
 *   output, the restatement stays silent instead of double-emitting.
 * - Message/text-block boundaries within a step (multiple assistant messages
 *   stream through one emitter, e.g. around vanilla-mode tool use) inject a
 *   paragraph break when the joined halves would otherwise fuse — Claude Code
 *   emits no separator between them, which used to concatenate the last word
 *   of one message with the first word of the next.
 */
export const createClaudeCodeStreamEmitter = (
  onStream?: (chunk: string) => void,
) => {
  let mode: "unknown" | "emit" | "suppress" = "unknown";
  let pending = "";
  let owner: "none" | "text" | "structured" = "none";
  let lastVisibleChar = "";
  let boundaryPending = false;
  let structuredDecoder: ReturnType<
    typeof createClaudeCodeFinalMessageDecoder
  > | null = null;
  let suppressedTextDecoder: ReturnType<
    typeof createClaudeCodeFinalMessageDecoder
  > | null = null;

  const emitVisible = (source: "text" | "structured", text: string) => {
    if (!text) return;
    if (owner === "none") {
      owner = source;
    } else if (owner !== source) {
      return;
    }
    let out = text;
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

  return (event: Record<string, unknown>) => {
    if (event.type !== "stream_event") return;
    const source = asObject(event.event) ?? event;
    if (source.type === "message_start") {
      boundaryPending = true;
      return;
    }
    if (source.type === "content_block_start") {
      const block = asObject(source.content_block);
      if (block?.type === "text") {
        boundaryPending = true;
      }
      structuredDecoder =
        block?.type === "tool_use" && block.name === "StructuredOutput"
          ? createClaudeCodeFinalMessageDecoder()
          : null;
      return;
    }
    if (source.type === "content_block_delta") {
      const rawDelta = asObject(source.delta);
      if (
        rawDelta?.type === "input_json_delta" &&
        structuredDecoder &&
        typeof rawDelta.partial_json === "string"
      ) {
        emitVisible(
          "structured",
          structuredDecoder.push(rawDelta.partial_json),
        );
        return;
      }
    }
    const delta = getClaudeCodeTextDeltaFromStreamEvent(event);
    if (!delta) return;
    if (mode === "emit") {
      emitVisible("text", delta);
      return;
    }
    if (mode === "suppress") {
      emitVisible("text", suppressedTextDecoder?.push(delta) ?? "");
      return;
    }
    pending += delta;
    const firstVisible = pending.trimStart().at(0);
    if (!firstVisible) return;
    if (firstVisible === "{" || firstVisible === "[") {
      // The step's visible text is a decision payload. Don't paint the raw
      // JSON — but if it turns out to be a "final" decision, stream its
      // decoded `message` so the answer still reveals progressively.
      mode = "suppress";
      suppressedTextDecoder = createClaudeCodeFinalMessageDecoder();
      emitVisible("text", suppressedTextDecoder.push(pending));
      pending = "";
      return;
    }
    mode = "emit";
    emitVisible("text", pending);
    pending = "";
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

const cleanupSessionProcess = (session: SessionState) => {
  if (!session.process) {
    return;
  }
  killProcess(session.process.child);
  session.process = undefined;
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

  async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
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

  dispose(): void {
    for (const child of this.activeProcesses.values()) {
      killProcess(child);
    }
    this.activeProcesses.clear();
    for (const session of this.sessions.values()) {
      cleanupSessionProcess(session);
      cleanupSessionArtifacts(session);
    }
    this.sessions.clear();
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (session.running || session.queue.length > 0) continue;
      if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) {
        cleanupSessionProcess(session);
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
      : buildClaudeCodeToolRuntimePrompt(request.systemPrompt, request.tools);
    let usage: ClaudeUsage | undefined;
    const turnFileChanges: FileChangeRecord[] = [];
    const turnFileChangeKeys = new Set<string>();
    let nextPrompt = buildInitialPrompt(session, request);
    let nextPromptImages: ClaudeCodePromptImage[] = [];

    // Every user message reattempts the configured model: a fallback from a
    // previous turn does not stick to the session. The next
    // ensureStreamingProcess sees the config change and restarts the CLI on
    // the configured model with --resume.
    session.modelOverride = undefined;
    session.fableSafetyFailures = 0;

    // The compaction loop breaker counts per Stella turn, across all
    // structured steps of that turn.
    if (session.process) {
      session.process.compacting = false;
      session.process.compactionCount = 0;
    }

    const recoveryBudget = { remaining: MAX_STEP_RECOVERIES_PER_TURN };
    for (;;) {
      const response = await this.executeStructuredStepWithRecovery(
        session,
        request,
        effectiveSystemPrompt,
        nextPrompt,
        nextPromptImages,
        recoveryBudget,
      );
      usage = mergeUsage(usage, response.usage);
      mergeFileChanges(
        turnFileChanges,
        turnFileChangeKeys,
        response.fileChanges,
      );
      if (response.action.type === "final") {
        return {
          text: response.action.message,
          sessionId: response.sessionId,
          usage,
          ...(turnFileChanges.length > 0
            ? { fileChanges: turnFileChanges }
            : {}),
        };
      }
      const toolName = response.action.toolName;
      const toolArgs = response.action.args;
      const toolCallId = crypto.randomUUID();
      const toolResult = await request.executeTool(
        toolCallId,
        toolName,
        toolArgs,
        request.abortSignal,
        (update) => {
          request.onToolUpdate?.({
            toolCallId,
            toolName,
            update,
          });
        },
      );
      const toolResultPrompt = await buildToolResultPrompt({
        toolCallId,
        toolName,
        toolArgs,
        toolResult,
      });
      nextPrompt = toolResultPrompt.text;
      nextPromptImages = toolResultPrompt.images;
    }
  }

  /**
   * Run one structured step, absorbing recoverable CLI flakiness within the
   * turn's shared recovery budget:
   *
   * - `process_ended`: the CLI died (or exited cleanly) before delivering the
   *   step's result. Respawn and resend the same prompt; the spawn path
   *   resumes the persisted transcript when possible and otherwise falls back
   *   to reseeding from `resumeFallbackPrompt`. If the failed attempt had
   *   already applied native file writes, the retry switches to a
   *   non-mutating reconciliation prompt so those edits are never replayed.
   * - `malformed_result`: the CLI answered but the payload was unusable
   *   (empty result / invalid decision JSON). The session process is still
   *   alive with full context, so send a corrective nudge prompt instead.
   *
   * Native file writes observed on failed attempts are merged into the
   * eventual step result so recoveries never drop artifacts. Aborted runs
   * never retry; exhausted budgets rethrow with an actionable message.
   */
  private async executeStructuredStepWithRecovery(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    promptImages: readonly ClaudeCodePromptImage[],
    recoveryBudget: { remaining: number },
  ): Promise<StructuredStepResult> {
    let currentPrompt = prompt;
    let currentPromptImages = promptImages;
    const failedAttemptFileChanges: FileChangeRecord[] = [];
    const failedAttemptFileChangeKeys = new Set<string>();
    for (;;) {
      try {
        const result = await this.executeStructuredStep(
          session,
          request,
          effectiveSystemPrompt,
          currentPrompt,
          currentPromptImages,
          failedAttemptFileChanges,
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
        // Fable refusal/overload policy: retry the configured model, then
        // fall back — resending the SAME prompt either way (a refused step
        // produced no decision to preserve). Separate cap from the shared
        // recovery budget: capped by SAFETY_ABORT_FABLE_ATTEMPTS plus one
        // fallback per turn, so this cannot loop.
        if (this.applyFableFallbackPolicy(session, request, error)) {
          continue;
        }
        const recoverable = asRecoverableStepError(error);
        if (!recoverable) {
          throw error;
        }
        mergeFileChanges(
          failedAttemptFileChanges,
          failedAttemptFileChangeKeys,
          recoverable.fileChanges,
        );
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
          if (failedAttemptFileChanges.length > 0) {
            currentPrompt = buildSideEffectReconciliationPrompt(
              failedAttemptFileChanges,
            );
            currentPromptImages = [];
          }
          continue;
        }
        currentPrompt = buildDecisionRetryPrompt(Boolean(request.vanilla));
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

  private async executeStructuredStep(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    promptImages: readonly ClaudeCodePromptImage[],
    observedMutations: readonly FileChangeRecord[] = [],
  ): Promise<StructuredStepResult> {
    return await this.executeStructuredStepWithMode(
      session,
      request,
      effectiveSystemPrompt,
      prompt,
      session.resumeReady,
      true,
      promptImages,
      observedMutations,
    );
  }

  /**
   * `observedMutations` carries native file writes already applied by
   * earlier attempts of THIS step. Every reseed path below (missing resume,
   * compaction loop) must honor it: once mutations are known, the reseed
   * prompt is the reconciliation prompt — never `resumeFallbackPrompt`,
   * whose history+request would replay the mutations on the fresh session.
   */
  private async executeStructuredStepWithMode(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    useResume: boolean,
    allowCompactionLoopRestart = true,
    promptImages: readonly ClaudeCodePromptImage[] = [],
    observedMutations: readonly FileChangeRecord[] = [],
  ): Promise<StructuredStepResult> {
    // Reseeded sessions have no transcript, so a mutation-guarded reseed
    // embeds the would-be seed prompt as reference-only context.
    const buildReseedPrompt = (
      mutations: readonly FileChangeRecord[],
    ): string =>
      mutations.length > 0
        ? buildSideEffectReconciliationPrompt(
            mutations,
            request.resumeFallbackPrompt ?? prompt,
          )
        : (request.resumeFallbackPrompt ?? prompt);
    try {
      const processState = this.ensureStreamingProcess(
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
        return await this.executeStructuredStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          prompt,
          true,
          allowCompactionLoopRestart,
          promptImages,
          observedMutations,
        );
      }
      if (useResume && isMissingResumeSessionError(message)) {
        this.resetStreamingProcess(request.sessionKey, session);
        session.sessionId = crypto.randomUUID();
        session.turnCount = 0;
        session.resumeReady = false;
        return await this.executeStructuredStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          buildReseedPrompt(observedMutations),
          false,
          allowCompactionLoopRestart,
          promptImages,
          observedMutations,
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
        this.resetStreamingProcess(request.sessionKey, session);
        session.sessionId = crypto.randomUUID();
        session.turnCount = 0;
        session.resumeReady = false;
        const result = await this.executeStructuredStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          buildReseedPrompt(mutations),
          false,
          false,
          promptImages,
          mutations,
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
      // Stella takeover mode: strip Claude Code's own tools and MCP servers
      // and route every tool call through the Stella bridge via the
      // structured decision schema. Vanilla mode keeps Claude Code's own
      // tools/config (though still headless: permissions-skip, stream-json,
      // and hook settings above apply in both modes).
      args.push(
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--disable-slash-commands",
        "--json-schema",
        CLAUDE_CODE_RESPONSE_SCHEMA,
        "--tools",
        "",
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
  ): string {
    return JSON.stringify([
      session.modelOverride ?? parseClaudeCodeModel(request.modelId) ?? "",
      request.effortLevel?.trim() ?? "",
      Boolean(request.vanilla),
      effectiveSystemPrompt.trim(),
      request.autoCompactWindowTokens ?? null,
      request.autoCompactTriggerPct ?? null,
    ]);
  }

  private ensureStreamingProcess(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    useResume: boolean,
  ): ClaudeCodeStreamingProcess {
    const launchConfig = this.buildProcessLaunchConfig(
      session,
      request,
      effectiveSystemPrompt,
    );
    if (session.process && !session.process.closed) {
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
    const childEnv = buildExternalCliChildEnv(executablePath);
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
            const stepResult = this.parseStructuredResultPayload(
              session,
              parsedLine,
              processState.stderrText,
              Boolean(completed.request.vanilla),
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
            completed.reject(error);
          }
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      processState.stdoutBuffer += chunk.toString("utf8");
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
      if (session.process === processState) {
        session.process = undefined;
      }
      // A restart may already have registered a replacement child under this
      // session key; only remove OUR child from tracking.
      if (this.activeProcesses.get(request.sessionKey) === child) {
        this.activeProcesses.delete(request.sessionKey);
      }
      for (const pending of processState.pending.splice(0)) {
        this.detachAbortListener(pending);
        pending.reject(wrapped);
      }
    });

    child.once("close", (code) => {
      consumeStdout(true);
      processState.closed = true;
      if (session.process === processState) {
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
              ),
        );
      }
    });

    return processState;
  }

  private async sendStreamingPrompt(
    session: SessionState,
    processState: ClaudeCodeStreamingProcess,
    request: ClaudeCodeTurnRequest,
    prompt: string,
    promptImages: readonly ClaudeCodePromptImage[] = [],
  ): Promise<StructuredStepResult> {
    if (processState.closed || processState.child.stdin.destroyed) {
      throw new ClaudeCodeProcessEndedError("Claude Code stream is closed.");
    }
    return await new Promise<StructuredStepResult>((resolve, reject) => {
      const pending: PendingStructuredPrompt = {
        request,
        resolve,
        reject,
        emitStreamDelta: createClaudeCodeStreamEmitter(request.onStream),
        fileChanges: [],
      };
      this.refreshPendingIdleTimer(processState, pending);
      if (request.abortSignal) {
        pending.abortListener = () => abortProcess(processState.child);
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
          ),
        );
      });
    });
  }

  private detachAbortListener(pending: PendingStructuredPrompt): void {
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
    pending: PendingStructuredPrompt,
  ): void {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
    }
    const timeoutMs = pending.hasOutput
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
          `Claude Code did not produce output for ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    pending.idleTimer.unref?.();
  }

  private parseStructuredResultPayload(
    session: SessionState,
    parsed: Record<string, unknown>,
    stderrText: string,
    vanilla = false,
  ): StructuredStepResult {
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
      throw new Error(resultError);
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
    if (vanilla) {
      // No decision schema in vanilla mode — the result text IS the final
      // answer, even when it happens to look like JSON. An empty result is
      // an error, not a silent empty success.
      const message =
        typeof parsed.result === "string" ? parsed.result.trim() : "";
      if (!message) {
        throw new ClaudeCodeMalformedResultError(
          stderrText.trim() || "Claude Code returned an empty result.",
          "empty_result",
        );
      }
      session.turnCount += 1;
      session.lastUsedAt = Date.now();
      return {
        action: {
          type: "final",
          message,
        },
        sessionId: session.sessionId,
        usage,
      };
    }
    const decision =
      parseClaudeCodeDecision(parsed.structured_output) ??
      (typeof parsed.result === "string"
        ? parseClaudeCodeDecision(
            (() => {
              try {
                return JSON.parse(parsed.result) as unknown;
              } catch {
                return null;
              }
            })(),
          )
        : null);
    const naturalResult =
      typeof parsed.result === "string" ? parsed.result.trim() : "";
    if (!decision && naturalResult && !naturalResult.startsWith("{")) {
      session.turnCount += 1;
      session.lastUsedAt = Date.now();
      return {
        action: {
          type: "final",
          message: naturalResult,
        },
        sessionId: session.sessionId,
        usage,
      };
    }
    if (!decision) {
      const stderrMessage = stderrText.trim();
      throw new ClaudeCodeMalformedResultError(
        stderrMessage ||
          "Claude Code returned an invalid Stella decision payload.",
        "invalid_decision",
      );
    }

    session.turnCount += 1;
    session.lastUsedAt = Date.now();

    return {
      action: decision,
      sessionId: session.sessionId,
      usage,
    };
  }

  /**
   * Kill a session process stuck in a compaction loop and fail its in-flight
   * prompts with a recognizable error so `executeStructuredStepWithMode` can
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
    killProcess(processState.child);
    for (const pending of failed) {
      this.detachAbortListener(pending);
      // Typed and file-change-aware: the reseed path must know which native
      // writes this step already applied so it reconciles instead of
      // replaying them, and reports them on the eventual result.
      pending.reject(new ClaudeCodeCompactionLoopError(pending.fileChanges));
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
