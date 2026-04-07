import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { RuntimeAttachmentRef } from "../../protocol/index.js";
import type { ToolMetadata, ToolResult } from "../tools/types.js";

const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const MAX_STDERR_CAPTURE = 4_000;
const MAX_TOOL_STEPS = 64;
const MAX_TOOL_RESULT_CHARS = 80_000;
const CLAUDE_CODE_COMPACTING_TEXT = "Compacting context";
const CLAUDE_CODE_RUNNING_TEXT = "Working";

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
  state: "running" | "compacting";
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
};

type ClaudeCodeTurnRequest = {
  runId: string;
  sessionKey: string;
  persistedSessionId?: string;
  prompt: string;
  systemPrompt?: string;
  modelId: string;
  cwd?: string;
  attachments?: RuntimeAttachmentRef[];
  tools: ToolMetadata[];
  executeTool: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  onStatusChange?: (status: ClaudeCodeStatusChange) => void;
  abortSignal?: AbortSignal;
};

type QueueJob = {
  request: ClaudeCodeTurnRequest;
  resolve: (value: ClaudeCodeTurnResult) => void;
  reject: (reason?: unknown) => void;
};

type SessionState = {
  sessionId: string;
  cwd?: string;
  lastUsedAt: number;
  turnCount: number;
  running: boolean;
  queue: QueueJob[];
  artifactDir?: string;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
};

const isSessionAlreadyInUseError = (message: string): boolean =>
  /Session ID .* is already in use\./i.test(message);

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

const trimForPrompt = (value: string, maxChars = MAX_TOOL_RESULT_CHARS): string =>
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

const buildToolResultPrompt = (args: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: ToolResult;
}): string => {
  const serializedResult = trimForPrompt(
    stringifyUnknown({
      result: args.toolResult.result,
      details: args.toolResult.details,
      error: args.toolResult.error ?? null,
    }),
  );
  return [
    "A Stella tool request has completed.",
    `Tool call id: ${args.toolCallId}`,
    `Tool name: ${args.toolName}`,
    "Tool arguments:",
    stringifyUnknown(args.toolArgs),
    "Tool result:",
    serializedResult,
    "Decide the next step and respond with JSON only.",
  ].join("\n\n");
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
    "For every turn, respond with a JSON object that matches the provided schema.",
    'Use `{\"type\":\"tool_request\",\"toolName\":\"...\",\"args\":{...}}` when you need a Stella tool.',
    'Use `{\"type\":\"final\",\"message\":\"...\"}` when you are ready to answer the user.',
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

  if (type === "system" && subtype === "status" && statusValue === "compacting") {
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

const emitClaudeCodeStatusFromStreamEvent = (
  event: Record<string, unknown>,
  onStatusChange?: (status: ClaudeCodeStatusChange) => void,
) => {
  const status = getClaudeCodeStatusChangeFromStreamEvent(event);
  if (status) {
    onStatusChange?.(status);
  }
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

const ensureSessionState = (
  sessions: Map<string, SessionState>,
  request: Pick<ClaudeCodeTurnRequest, "sessionKey" | "persistedSessionId" | "cwd">,
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
      }
      return existing;
    }
    cleanupSessionArtifacts(existing);
    const replacement: SessionState = {
      sessionId: persistedSessionId ?? crypto.randomUUID(),
      cwd: normalizedCwd,
      lastUsedAt: Date.now(),
      turnCount: persistedSessionId ? 1 : 0,
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
    running: false,
    queue: [],
  };
  sessions.set(sessionKey, created);
  return created;
};

class ClaudeCodeSessionRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

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

  dispose(): void {
    for (const child of this.activeProcesses.values()) {
      killProcess(child);
    }
    this.activeProcesses.clear();
    for (const session of this.sessions.values()) {
      cleanupSessionArtifacts(session);
    }
    this.sessions.clear();
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (session.running || session.queue.length > 0) continue;
      if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) {
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
    const effectiveSystemPrompt = buildClaudeCodeToolRuntimePrompt(
      request.systemPrompt,
      request.tools,
    );
    let usage: ClaudeUsage | undefined;
    let nextPrompt = buildInitialPrompt(session, request);

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      const response = await this.executeStructuredStep(
        session,
        request,
        effectiveSystemPrompt,
        nextPrompt,
      );
      usage = mergeUsage(usage, response.usage);
      if (response.action.type === "final") {
        return {
          text: response.action.message,
          sessionId: response.sessionId,
          usage,
        };
      }
      const toolCallId = crypto.randomUUID();
      const toolResult = await request.executeTool(
        toolCallId,
        response.action.toolName,
        response.action.args,
        request.abortSignal,
      );
      nextPrompt = buildToolResultPrompt({
        toolCallId,
        toolName: response.action.toolName,
        toolArgs: response.action.args,
        toolResult,
      });
    }

    throw new Error(
      `Claude Code exceeded the Stella tool-step limit of ${MAX_TOOL_STEPS}.`,
    );
  }

  private async executeStructuredStep(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
  ): Promise<{
    action: ClaudeCodeDecision;
    sessionId: string;
    usage?: ClaudeUsage;
  }> {
    return await this.executeStructuredStepWithMode(
      session,
      request,
      effectiveSystemPrompt,
      prompt,
      session.turnCount > 0,
    );
  }

  private async executeStructuredStepWithMode(
    session: SessionState,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    useResume: boolean,
  ): Promise<{
    action: ClaudeCodeDecision;
    sessionId: string;
    usage?: ClaudeUsage;
  }> {
    const modelName = parseClaudeCodeModel(request.modelId);
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--settings",
      CLAUDE_CODE_HOOK_SETTINGS,
      "--json-schema",
      CLAUDE_CODE_RESPONSE_SCHEMA,
      "--tools",
      "",
    ];
    if (effectiveSystemPrompt.trim()) {
      args.push("--system-prompt", effectiveSystemPrompt.trim());
    }
    if (modelName) {
      args.push("--model", modelName);
    }
    if (useResume) {
      args.push("--resume", session.sessionId);
    }

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: request.cwd,
    });
    this.activeProcesses.set(request.runId, child);

    let abortListener: (() => void) | null = null;
    if (request.abortSignal) {
      abortListener = () => abortProcess(child);
      if (request.abortSignal.aborted) {
        abortListener();
      } else {
        request.abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    let stderrText = "";
    let stdoutText = "";
    let stdoutBuffer = "";
    let finalSessionId = session.sessionId;
    let resultError: string | undefined;
    let resultPayload: Record<string, unknown> | null = null;

    const cleanUp = () => {
      if (abortListener && request.abortSignal) {
        request.abortSignal.removeEventListener("abort", abortListener);
      }
      this.activeProcesses.delete(request.runId);
    };

    const consumeStdout = (flush = false) => {
      const segments = flush ? [stdoutBuffer] : stdoutBuffer.split("\n");
      const completeSegments = flush ? segments : segments.slice(0, -1);
      stdoutBuffer = flush ? "" : segments[segments.length - 1] ?? "";
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
          finalSessionId = parsedLine.session_id.trim();
        }
        emitClaudeCodeStatusFromStreamEvent(parsedLine, request.onStatusChange);
        if (parsedLine.type === "result") {
          resultPayload = parsedLine;
        }
      }
    };

    const stdoutDone = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutText += text;
        stdoutBuffer += text;
        consumeStdout(false);
      });
      child.stdout.once("close", resolve);
    });

    const stderrDone = new Promise<void>((resolve) => {
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrText.length >= MAX_STDERR_CAPTURE) return;
        stderrText += chunk.toString("utf8");
        if (stderrText.length > MAX_STDERR_CAPTURE) {
          stderrText = stderrText.slice(0, MAX_STDERR_CAPTURE);
        }
      });
      child.stderr.once("close", () => resolve());
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        reject(new Error(`Failed to start Claude Code: ${normalizeErrorMessage(error)}`));
      });
      child.once("close", (code) => {
        resolve(code);
      });

      child.stdin.end(prompt);
    }).finally(cleanUp);

    await Promise.all([stdoutDone, stderrDone]);

    if (request.abortSignal?.aborted) {
      throw new Error("Claude Code run aborted.");
    }
    consumeStdout(true);
    if (exitCode !== 0 && !stdoutText.trim()) {
      const stderrMessage = stderrText.trim();
      if (!useResume && isSessionAlreadyInUseError(stderrMessage)) {
        return await this.executeStructuredStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          prompt,
          true,
        );
      }
      throw new Error(stderrMessage || `Claude Code exited with code ${exitCode ?? "unknown"}.`);
    }

    const parsed = resultPayload as Record<string, unknown> | null;
    if (parsed === null) {
      const stderrMessage = stderrText.trim();
      throw new Error(stderrMessage || "Claude Code returned invalid stream output.");
    }
    if (parsed.is_error === true) {
      const parsedError =
        (typeof parsed.result === "string" && parsed.result.trim()) ||
        (typeof parsed.error === "string" && parsed.error.trim()) ||
        "";
      resultError = parsedError || "Claude Code reported an error.";
    }
    if (resultError) {
      if (!useResume && isSessionAlreadyInUseError(resultError)) {
        return await this.executeStructuredStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          prompt,
          true,
        );
      }
      throw new Error(resultError);
    }
    const usageRaw = parsed.usage as Record<string, unknown> | undefined;
    const inputTokens = asNumber(usageRaw?.input_tokens ?? usageRaw?.inputTokens);
    const outputTokens = asNumber(usageRaw?.output_tokens ?? usageRaw?.outputTokens);
    const usage =
      inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined;
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
    if (!decision) {
      const stderrMessage = stderrText.trim();
      throw new Error(
        stderrMessage || "Claude Code returned an invalid Stella decision payload.",
      );
    }

    session.sessionId = finalSessionId;
    session.turnCount += 1;
    session.lastUsedAt = Date.now();

    return {
      action: decision,
      sessionId: finalSessionId,
      usage,
    };
  }
}

const runtime = new ClaudeCodeSessionRuntime();

export const isClaudeCodeModel = (modelId: string): boolean =>
  modelId.trim().startsWith(CLAUDE_CODE_MODEL_PREFIX);

export const runClaudeCodeTurn = async (request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> =>
  await runtime.runTurn(request);

export const shutdownClaudeCodeRuntime = (): void => {
  runtime.dispose();
};
