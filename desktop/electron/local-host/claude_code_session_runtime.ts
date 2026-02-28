import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import crypto from "crypto";
import readline from "readline";

const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const MAX_STDERR_CAPTURE = 4_000;

type ClaudeUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type ClaudeCodeTurnResult = {
  text: string;
  sessionId: string;
  usage?: ClaudeUsage;
};

type ClaudeCodeTurnRequest = {
  runId: string;
  sessionKey: string;
  prompt: string;
  modelId: string;
  abortSignal?: AbortSignal;
  onProgress?: (chunk: string) => void;
};

type QueueJob = {
  request: ClaudeCodeTurnRequest;
  resolve: (value: ClaudeCodeTurnResult) => void;
  reject: (reason?: unknown) => void;
};

type SessionState = {
  sessionId: string;
  lastUsedAt: number;
  turnCount: number;
  running: boolean;
  queue: QueueJob[];
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const extractStreamText = (line: Record<string, unknown>): string => {
  if (line.type !== "stream_event") return "";
  const event = line.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== "object") return "";

  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.text === "string") return delta.text;

  const contentBlock = event.content_block as Record<string, unknown> | undefined;
  if (contentBlock && typeof contentBlock.text === "string") return contentBlock.text;

  return "";
};

const extractAssistantText = (line: Record<string, unknown>): string => {
  if (line.type !== "assistant") return "";
  const message = line.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const typedEntry = entry as Record<string, unknown>;
    if (typedEntry.type === "text" && typeof typedEntry.text === "string") {
      textParts.push(typedEntry.text);
    }
  }
  return textParts.join("");
};

const normalizeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
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

const ensureSessionState = (sessions: Map<string, SessionState>, sessionKey: string): SessionState => {
  const existing = sessions.get(sessionKey);
  if (existing) return existing;
  const created: SessionState = {
    sessionId: crypto.randomUUID(),
    lastUsedAt: Date.now(),
    turnCount: 0,
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
    const session = ensureSessionState(this.sessions, request.sessionKey);
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
    this.sessions.clear();
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (session.running || session.queue.length > 0) continue;
      if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) {
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
    const modelName = parseClaudeCodeModel(request.modelId);
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (modelName) {
      args.push("--model", modelName);
    }
    if (session.turnCount > 0) {
      args.push("--resume", session.sessionId);
    } else {
      args.push("--session-id", session.sessionId);
    }

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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
    let streamedText = "";
    let finalText = "";
    let finalSessionId = session.sessionId;
    let usage: ClaudeUsage | undefined;
    let sawResult = false;
    let resultError: string | undefined;

    const cleanUp = () => {
      if (abortListener && request.abortSignal) {
        request.abortSignal.removeEventListener("abort", abortListener);
      }
      this.activeProcesses.delete(request.runId);
    };

    const stdoutDone = new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (rawLine) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
          return;
        }

        const streamChunk = extractStreamText(parsed);
        if (streamChunk) {
          streamedText += streamChunk;
          request.onProgress?.(streamChunk);
        }

        const assistantChunk = extractAssistantText(parsed);
        if (assistantChunk) {
          streamedText += assistantChunk;
          request.onProgress?.(assistantChunk);
        }

        if (parsed.type === "result") {
          sawResult = true;
          if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
            finalSessionId = parsed.session_id.trim();
          }
          if (typeof parsed.result === "string") {
            finalText = parsed.result;
          }
          const usageRaw = parsed.usage as Record<string, unknown> | undefined;
          const inputTokens = asNumber(usageRaw?.input_tokens ?? usageRaw?.inputTokens);
          const outputTokens = asNumber(usageRaw?.output_tokens ?? usageRaw?.outputTokens);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            usage = { inputTokens, outputTokens };
          }
          if (parsed.is_error === true) {
            const parsedError =
              (typeof parsed.result === "string" && parsed.result.trim()) ||
              (typeof parsed.error === "string" && parsed.error.trim()) ||
              "";
            resultError = parsedError || "Claude Code reported an error.";
          }
        }
      });
      rl.once("close", resolve);
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

      child.stdin.end(request.prompt);
    }).finally(cleanUp);

    await Promise.all([stdoutDone, stderrDone]);

    if (request.abortSignal?.aborted) {
      throw new Error("Claude Code run aborted.");
    }
    if (resultError) {
      throw new Error(resultError);
    }
    if (exitCode !== 0 && !sawResult) {
      const stderrMessage = stderrText.trim();
      throw new Error(stderrMessage || `Claude Code exited with code ${exitCode ?? "unknown"}.`);
    }

    const resolvedText = finalText || streamedText;
    if (!resolvedText.trim()) {
      const stderrMessage = stderrText.trim();
      throw new Error(stderrMessage || "Claude Code returned no output.");
    }

    session.sessionId = finalSessionId;
    session.turnCount += 1;
    session.lastUsedAt = Date.now();

    return {
      text: resolvedText,
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
