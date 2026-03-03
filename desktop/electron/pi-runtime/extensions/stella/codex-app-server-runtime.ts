import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 3;
const MIN_MAX_CONCURRENCY = 1;
const MAX_MAX_CONCURRENCY = 3;

type CodexUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type CodexAppServerTurnResult = {
  text: string;
  threadId: string;
  turnId: string;
  usage?: CodexUsage;
};

type CodexAppServerTurnRequest = {
  runId: string;
  sessionKey: string;
  prompt: string;
  cwd?: string;
  abortSignal?: AbortSignal;
  onProgress?: (chunk: string) => void;
  maxConcurrency?: number;
};

type QueueJob = {
  request: CodexAppServerTurnRequest;
  resolve: (value: CodexAppServerTurnResult) => void;
  reject: (reason?: unknown) => void;
};

type SessionState = {
  threadId?: string;
  cwd?: string;
  lastUsedAt: number;
  running: boolean;
  queue: QueueJob[];
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
  method?: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type TurnCompletion = {
  status: string;
  error?: string;
};

type TurnState = {
  turnId: string;
  threadId: string;
  text: string;
  usage?: CodexUsage;
  onProgress?: (chunk: string) => void;
  resolve: (value: TurnCompletion) => void;
  reject: (reason?: unknown) => void;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
};

const clampMaxConcurrency = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENCY;
  const rounded = Math.floor(value!);
  return Math.max(MIN_MAX_CONCURRENCY, Math.min(MAX_MAX_CONCURRENCY, rounded));
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

const ensureSessionState = (sessions: Map<string, SessionState>, sessionKey: string): SessionState => {
  const existing = sessions.get(sessionKey);
  if (existing) return existing;
  const created: SessionState = {
    threadId: undefined,
    cwd: undefined,
    lastUsedAt: Date.now(),
    running: false,
    queue: [],
  };
  sessions.set(sessionKey, created);
  return created;
};

class CodexAppServerRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly bufferedTurnCompletions = new Map<string, TurnCompletion>();

  private process: ChildProcessWithoutNullStreams | null = null;
  private processInitPromise: Promise<void> | null = null;
  private processReady = false;
  private outputBuffer = "";
  private requestSeq = 1;
  private runningTurns = 0;
  private maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  private stderrText = "";

  async runTurn(request: CodexAppServerTurnRequest): Promise<CodexAppServerTurnResult> {
    this.maxConcurrency = clampMaxConcurrency(request.maxConcurrency);
    const session = ensureSessionState(this.sessions, request.sessionKey);
    session.lastUsedAt = Date.now();

    return await new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      session.queue.push({ request, resolve, reject });
      this.pumpQueue();
    });
  }

  dispose(): void {
    if (this.process) {
      abortProcess(this.process);
      this.process = null;
    }
    this.processReady = false;
    this.processInitPromise = null;
    this.outputBuffer = "";
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server runtime disposed."));
    }
    this.pendingRequests.clear();
    for (const turnState of this.turnStates.values()) {
      turnState.reject(new Error("Codex app-server runtime disposed."));
    }
    this.turnStates.clear();
    this.bufferedTurnCompletions.clear();
    this.sessions.clear();
    this.runningTurns = 0;
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

  private pumpQueue(): void {
    this.pruneIdleSessions();
    while (this.runningTurns < this.maxConcurrency) {
      const next = this.findNextRunnableSession();
      if (!next) break;
      const [sessionKey, session] = next;
      const job = session.queue.shift();
      if (!job) continue;
      session.running = true;
      this.runningTurns += 1;
      void this.executeQueuedJob(sessionKey, session, job);
    }
  }

  private findNextRunnableSession(): [string, SessionState] | null {
    for (const entry of this.sessions.entries()) {
      const [, session] = entry;
      if (!session.running && session.queue.length > 0) {
        return entry;
      }
    }
    return null;
  }

  private async executeQueuedJob(
    _sessionKey: string,
    session: SessionState,
    job: QueueJob,
  ): Promise<void> {
    try {
      const result = await this.executeTurn(session, job.request);
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      session.running = false;
      session.lastUsedAt = Date.now();
      this.runningTurns = Math.max(0, this.runningTurns - 1);
      this.pumpQueue();
    }
  }

  private async executeTurn(
    session: SessionState,
    request: CodexAppServerTurnRequest,
  ): Promise<CodexAppServerTurnResult> {
    if (request.abortSignal?.aborted) {
      throw new Error("Codex App Server turn aborted.");
    }

    await this.ensureProcessReady();

    const threadId = await this.getOrCreateThread(session, request.cwd);
    const startResult = await this.rpcRequest<{
      turn?: { id?: string };
      turnId?: string;
    }>("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt }],
    });

    const turnId = startResult.turn?.id ?? startResult.turnId;
    if (!turnId) {
      throw new Error("Codex App Server did not return a turn ID.");
    }

    let interruptedByAbort = false;
    let abortListener: (() => void) | null = null;

    const completion = await new Promise<TurnCompletion>((resolve, reject) => {
      const turnState: TurnState = {
        turnId,
        threadId,
        text: "",
        onProgress: request.onProgress,
        resolve,
        reject,
      };
      this.turnStates.set(turnId, turnState);

      const buffered = this.bufferedTurnCompletions.get(turnId);
      if (buffered) {
        this.bufferedTurnCompletions.delete(turnId);
        this.finishTurn(turnId, buffered);
      }

      if (request.abortSignal) {
        abortListener = () => {
          interruptedByAbort = true;
          void this.rpcRequest<Record<string, unknown>>("turn/interrupt", {
            threadId,
            turnId,
          }).catch(() => undefined);
        };
        if (request.abortSignal.aborted) {
          abortListener();
        } else {
          request.abortSignal.addEventListener("abort", abortListener, { once: true });
        }
      }
    }).finally(() => {
      if (abortListener && request.abortSignal) {
        request.abortSignal.removeEventListener("abort", abortListener);
      }
    });

    const turnState = this.turnStates.get(turnId);
    const text = turnState?.text ?? "";
    const usage = turnState?.usage;
    this.turnStates.delete(turnId);

    if (completion.status === "interrupted" && (interruptedByAbort || request.abortSignal?.aborted)) {
      throw new Error("Codex App Server turn aborted.");
    }
    if (completion.status !== "completed") {
      const suffix = completion.error ? `: ${completion.error}` : "";
      throw new Error(`Codex App Server turn ended with status "${completion.status}"${suffix}`);
    }
    if (!text.trim()) {
      throw new Error("Codex App Server returned no output.");
    }

    return {
      text,
      threadId,
      turnId,
      usage,
    };
  }

  private async getOrCreateThread(session: SessionState, cwd?: string): Promise<string> {
    if (session.threadId) return session.threadId;
    const params: Record<string, unknown> = {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    if (cwd) {
      params.cwd = cwd;
    }
    const result = await this.rpcRequest<{
      thread?: { id?: string };
    }>("thread/start", params);
    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("Codex App Server did not return a thread ID.");
    }
    session.threadId = threadId;
    session.cwd = cwd;
    return threadId;
  }

  private async ensureProcessReady(): Promise<void> {
    if (this.process && this.process.exitCode === null && this.processReady) {
      return;
    }
    if (this.processInitPromise) {
      await this.processInitPromise;
      return;
    }

    this.processInitPromise = (async () => {
      this.spawnProcess();
      await this.rpcRequest<Record<string, unknown>>("initialize", {
        clientInfo: { name: "stella", version: "1.0.0" },
      });
      this.processReady = true;
    })();

    try {
      await this.processInitPromise;
    } catch (error) {
      const message = normalizeErrorMessage(error);
      throw new Error(
        `Codex App Server unavailable. Ensure the "codex" CLI is installed and on PATH. ${message}`,
      );
    } finally {
      this.processInitPromise = null;
    }
  }

  private spawnProcess(): void {
    if (this.process && this.process.exitCode === null) {
      return;
    }

    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process = child;
    this.processReady = false;
    this.outputBuffer = "";
    this.stderrText = "";

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
      if (this.stderrText.length > 8_000) {
        this.stderrText = this.stderrText.slice(this.stderrText.length - 8_000);
      }
    });

    child.once("error", (error) => {
      this.handleProcessFailure(new Error(`Failed to start Codex app-server: ${normalizeErrorMessage(error)}`));
    });

    child.once("exit", (code, signal) => {
      const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const stderr = this.stderrText.trim();
      const suffix = stderr ? ` | ${stderr}` : "";
      this.handleProcessFailure(new Error(`Codex app-server exited with ${status}${suffix}`));
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.outputBuffer += chunk;
    let lineEnd = this.outputBuffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = this.outputBuffer.slice(0, lineEnd).trim();
      this.outputBuffer = this.outputBuffer.slice(lineEnd + 1);
      if (line.length > 0) {
        this.handleStdoutLine(line);
      }
      lineEnd = this.outputBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id === "number" && this.pendingRequests.has(parsed.id)) {
      const pending = this.pendingRequests.get(parsed.id)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || "Codex app-server request failed."));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (!parsed.method) return;
    this.handleNotification(parsed.method, parsed.params);
  }

  private handleNotification(method: string, params: unknown): void {
    const paramsRecord = asRecord(params);
    if (!paramsRecord) return;

    if (method === "item/agentMessage/delta") {
      const turnId = asString(paramsRecord.turnId);
      const delta = asString(paramsRecord.delta);
      if (turnId && delta) {
        this.appendTurnText(turnId, delta);
      }
      return;
    }

    if (method === "item/completed") {
      const turnId = asString(paramsRecord.turnId);
      const item = asRecord(paramsRecord.item);
      if (!turnId || !item) return;
      if (item.type === "agentMessage") {
        const text = asString(item.text);
        if (text) {
          this.ensureTurnText(turnId, text);
        }
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const turnId = asString(paramsRecord.turnId);
      const tokenUsage = asRecord(paramsRecord.tokenUsage);
      const last = asRecord(tokenUsage?.last);
      if (!turnId || !last) return;
      const inputTokens = asNumber(last.inputTokens);
      const outputTokens = asNumber(last.outputTokens);
      const state = this.turnStates.get(turnId);
      if (!state) return;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        state.usage = { inputTokens, outputTokens };
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(paramsRecord.turn);
      const turnId = asString(turn?.id);
      const status = asString(turn?.status) ?? "completed";
      const error = asString(turn?.error);
      if (turnId) {
        this.finishTurn(turnId, { status, error });
      }
      return;
    }

    if (method === "turn/failed") {
      const turn = asRecord(paramsRecord.turn);
      const turnId = asString(turn?.id) ?? asString(paramsRecord.turnId);
      const error = asString(paramsRecord.error) ?? asString(turn?.error) ?? "Codex turn failed.";
      if (turnId) {
        this.finishTurn(turnId, { status: "failed", error });
      }
    }
  }

  private appendTurnText(turnId: string, delta: string): void {
    const state = this.turnStates.get(turnId);
    if (!state) return;
    state.text += delta;
    state.onProgress?.(delta);
  }

  private ensureTurnText(turnId: string, text: string): void {
    const state = this.turnStates.get(turnId);
    if (!state) return;
    if (state.text.length > 0) return;
    state.text = text;
    state.onProgress?.(text);
  }

  private finishTurn(turnId: string, completion: TurnCompletion): void {
    const state = this.turnStates.get(turnId);
    if (!state) {
      this.bufferedTurnCompletions.set(turnId, completion);
      return;
    }
    state.resolve(completion);
  }

  private handleProcessFailure(error: Error): void {
    if (!this.process) return;
    this.process = null;
    this.processReady = false;
    this.processInitPromise = null;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const turnState of this.turnStates.values()) {
      turnState.reject(error);
    }
    this.turnStates.clear();
    this.bufferedTurnCompletions.clear();

    for (const session of this.sessions.values()) {
      session.threadId = undefined;
      session.running = false;
      session.lastUsedAt = Date.now();
    }
  }

  private async rpcRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process || this.process.exitCode !== null) {
      if (method !== "initialize") {
        await this.ensureProcessReady();
      } else {
        this.spawnProcess();
      }
    }
    if (!this.process || this.process.exitCode !== null) {
      throw new Error("Codex app-server is not running.");
    }

    const id = this.requestSeq++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out (${method}).`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.process!.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to send Codex app-server request: ${normalizeErrorMessage(error)}`));
      }
    });

    return result as T;
  }
}

const runtime = new CodexAppServerRuntime();

export const runCodexAppServerTurn = async (
  request: CodexAppServerTurnRequest,
): Promise<CodexAppServerTurnResult> =>
  await runtime.runTurn(request);

export const shutdownCodexAppServerRuntime = (): void => {
  runtime.dispose();
};
