/**
 * Host for the Codex-style Exec runtime.
 *
 * Each active Exec cell gets its own worker thread. That lets yielded cells
 * keep running independently, lets `Wait({ terminate: true })` kill exactly
 * the targeted cell, and keeps runaway sync loops from poisoning unrelated
 * Exec calls.
 *
 * The host owns the durable per-conversation `store`/`load` snapshot. Each
 * worker gets a seeded copy when its cell starts and streams `store(...)`
 * updates back to the host as they happen, so state survives worker kills and
 * respawns.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { ToolContext, ToolHandlerExtras } from "../tools/types.js";
import {
  type ExecContentItem,
  type ExecToolDefinition,
  type ExecToolRegistry,
} from "../tools/registry/registry.js";

const EXEC_WORKER_TS_PATH = fileURLToPath(
  new URL("./exec-worker.ts", import.meta.url),
);
const EXEC_WORKER_JS_PATH = fileURLToPath(
  new URL("./exec-worker.js", import.meta.url),
);
const EXEC_WORKER_CACHE_DIR = fileURLToPath(
  new URL("./.exec-worker-cache/", import.meta.url),
);

const isBunRuntime =
  typeof (process.versions as Record<string, string | undefined>).bun ===
  "string";

export type ExecCellPhase = "compile" | "execute" | "tool" | "host";

export type ExecToolCallRecord = {
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
};

export type ExecCellResult =
  | {
      kind: "completed";
      cellId: string;
      value: unknown;
      content: ExecContentItem[];
      calls: ExecToolCallRecord[];
      durationMs: number;
    }
  | {
      kind: "failed";
      cellId: string;
      phase: ExecCellPhase;
      message: string;
      content: ExecContentItem[];
      calls: ExecToolCallRecord[];
      durationMs: number;
    }
  | {
      kind: "yielded";
      cellId: string;
      reason: "yield_control" | "pragma" | "wait_request";
      content: ExecContentItem[];
      calls: ExecToolCallRecord[];
      durationMs: number;
    };

export type ExecuteRequest = {
  cellId?: string;
  summary: string;
  source: string;
  context: ToolContext;
  toolHandlerExtras?: ToolHandlerExtras;
  agentType?: string;
  timeoutMs?: number;
  yieldAfterMs?: number;
};

export type WaitRequest = {
  cellId: string;
  yieldAfterMs?: number;
  terminate?: boolean;
};

type WorkerToHostMessage =
  | { type: "ready"; workerData?: unknown }
  | {
      type: "tool_call";
      requestId: string;
      cellId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "content";
      cellId: string;
      item: ExecContentItem;
    }
  | { type: "notify"; cellId: string; text: string }
  | { type: "state_set"; cellId: string; key: string; value: unknown }
  | { type: "yield"; cellId: string; requestId: string }
  | {
      type: "result";
      cellId: string;
      success: boolean;
      value?: unknown;
      message?: string;
      phase?: ExecCellPhase;
      stack?: string;
    };

type CellWaiter = {
  resolve: (result: ExecCellResult) => void;
};

type CellState = {
  cellId: string;
  startedAt: number;
  worker: Worker | null;
  context: ToolContext;
  toolHandlerExtras?: ToolHandlerExtras;
  enabledToolsByName: Map<string, ExecToolDefinition>;
  content: ExecContentItem[];
  toolCalls: ExecToolCallRecord[];
  waiter?: CellWaiter;
  yieldRequestId?: string;
  yieldedReason?: "yield_control" | "pragma" | "wait_request";
  yieldTimer?: NodeJS.Timeout;
  softTimeoutTimer?: NodeJS.Timeout;
  hardEscalationTimer?: NodeJS.Timeout;
  parkedResult?: ExecCellResult;
  timedOut?: boolean;
};

export type ExecHostOptions = {
  registry: ExecToolRegistry;
  agentType?: string;
  defaultTimeoutMs?: number;
  defaultYieldAfterMs?: number;
  /**
   * When a cell exceeds its soft timeout, the current `Exec` promise fails
   * immediately. If the worker is still alive after this grace window
   * (typically because the cell is stuck in a synchronous loop), that worker is
   * forcibly terminated.
   */
  defaultHardTerminationGraceMs?: number;
  onUpdate?: (event: ExecHostEvent) => void;
};

export type ExecHostEvent =
  | {
      type: "cell_started";
      cellId: string;
      summary: string;
    }
  | {
      type: "tool_call";
      cellId: string;
      toolName: string;
      argsPreview: string;
    }
  | {
      type: "tool_result";
      cellId: string;
      toolName: string;
      durationMs: number;
      resultPreview?: string;
      error?: string;
    }
  | {
      type: "notify";
      cellId: string;
      text: string;
    }
  | {
      type: "content";
      cellId: string;
      item: ExecContentItem;
    }
  | {
      type: "cell_finished";
      cellId: string;
      success: boolean;
      durationMs: number;
    }
  | {
      type: "cell_yielded";
      cellId: string;
      reason: "yield_control" | "pragma" | "wait_request";
      durationMs: number;
    };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_YIELD_AFTER_MS = 10_000;
const DEFAULT_HARD_TERMINATION_GRACE_MS = 2_000;

const PRAGMA_RE = /^[\t ]*\/\/\s*@exec:\s*([^\r\n]+)/m;

const parsePragma = (
  source: string,
): { yieldAfterMs?: number } => {
  const firstNonEmpty =
    source.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
  const match = firstNonEmpty.match(PRAGMA_RE);
  if (!match) return {};
  const directives: { yieldAfterMs?: number } = {};
  for (const part of match[1].split(/[,\s]+/u)) {
    const [key, value] = part.split("=");
    if (key === "yield_after_ms" && value) {
      const ms = Number(value);
      if (Number.isFinite(ms)) {
        directives.yieldAfterMs = ms;
      }
    }
  }
  return directives;
};

const previewUnknown = (value: unknown, max = 240): string => {
  if (typeof value === "string") {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return "";
    return json.length <= max ? json : `${json.slice(0, max - 1)}…`;
  } catch {
    return String(value);
  }
};

const ensureJsonSerializable = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
};

const snapshotToolCalls = (calls: ExecToolCallRecord[]): ExecToolCallRecord[] =>
  calls.map((call) => ({
    toolName: call.toolName,
    args: ensureJsonSerializable(call.args),
    ...(call.error ? { error: call.error } : {}),
    ...("result" in call
      ? { result: ensureJsonSerializable(call.result) }
      : {}),
  }));

const resolveWorkerScriptPath = async (): Promise<string> => {
  if (isBunRuntime && existsSync(EXEC_WORKER_TS_PATH)) {
    return EXEC_WORKER_TS_PATH;
  }
  if (existsSync(EXEC_WORKER_JS_PATH)) {
    return EXEC_WORKER_JS_PATH;
  }
  if (!existsSync(EXEC_WORKER_TS_PATH)) {
    throw new Error("Exec worker source is missing.");
  }
  const stat = await fs.stat(EXEC_WORKER_TS_PATH);
  const cachePath = path.join(
    EXEC_WORKER_CACHE_DIR,
    `exec-worker.${Math.floor(stat.mtimeMs).toString(36)}.cjs`,
  );
  if (existsSync(cachePath)) return cachePath;
  const { transform } = await import("esbuild");
  const source = await fs.readFile(EXEC_WORKER_TS_PATH, "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: "inline",
  });
  await fs.mkdir(EXEC_WORKER_CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath, result.code, "utf8");
  return cachePath;
};

export const createExecHost = (options: ExecHostOptions) => {
  const cells = new Map<string, CellState>();
  const workerToCellId = new Map<Worker, string>();
  const activeWorkers = new Set<Worker>();
  const storeByConversation = new Map<string, Map<string, unknown>>();
  const hardTerminationGraceMs =
    options.defaultHardTerminationGraceMs ?? DEFAULT_HARD_TERMINATION_GRACE_MS;

  let nextCellId = 1;

  const newCellId = () => `cell-${(nextCellId++).toString(36)}`;

  const emit = (event: ExecHostEvent) => {
    options.onUpdate?.(event);
  };

  const getConversationStore = (conversationId: string) => {
    const existing = storeByConversation.get(conversationId);
    if (existing) return existing;
    const created = new Map<string, unknown>();
    storeByConversation.set(conversationId, created);
    return created;
  };

  const snapshotConversationStore = (
    context: ToolContext,
  ): Array<[string, unknown]> =>
    Array.from(getConversationStore(context.conversationId).entries()).map(
      ([key, value]) => [key, ensureJsonSerializable(value)],
    );

  const clearYieldTimer = (cell: CellState) => {
    if (cell.yieldTimer) {
      clearTimeout(cell.yieldTimer);
      cell.yieldTimer = undefined;
    }
  };

  const clearSoftTimeoutTimer = (cell: CellState) => {
    if (cell.softTimeoutTimer) {
      clearTimeout(cell.softTimeoutTimer);
      cell.softTimeoutTimer = undefined;
    }
  };

  const clearHardEscalationTimer = (cell: CellState) => {
    if (cell.hardEscalationTimer) {
      clearTimeout(cell.hardEscalationTimer);
      cell.hardEscalationTimer = undefined;
    }
  };

  const buildCompletedResult = (
    cell: CellState,
    value: unknown,
  ): ExecCellResult => ({
    kind: "completed",
    cellId: cell.cellId,
    value,
    content: cell.content,
    calls: snapshotToolCalls(cell.toolCalls),
    durationMs: Date.now() - cell.startedAt,
  });

  const buildFailedResult = (
    cell: CellState,
    phase: ExecCellPhase,
    message: string,
  ): ExecCellResult => ({
    kind: "failed",
    cellId: cell.cellId,
    phase,
    message,
    content: cell.content,
    calls: snapshotToolCalls(cell.toolCalls),
    durationMs: Date.now() - cell.startedAt,
  });

  const buildYieldedResult = (
    cell: CellState,
    reason: "yield_control" | "pragma" | "wait_request",
  ): ExecCellResult => ({
    kind: "yielded",
    cellId: cell.cellId,
    reason,
    content: cell.content,
    calls: snapshotToolCalls(cell.toolCalls),
    durationMs: Date.now() - cell.startedAt,
  });

  const stopWorker = async (worker: Worker | null) => {
    if (!worker) return;
    workerToCellId.delete(worker);
    activeWorkers.delete(worker);
    try {
      await worker.terminate();
    } catch {
      // Best-effort cleanup.
    }
  };

  const cleanupCell = (cell: CellState) => {
    cells.delete(cell.cellId);
    clearYieldTimer(cell);
    clearSoftTimeoutTimer(cell);
    clearHardEscalationTimer(cell);
  };

  const parkOrDeliverTerminalResult = (
    cell: CellState,
    result: ExecCellResult,
  ) => {
    clearYieldTimer(cell);
    clearSoftTimeoutTimer(cell);
    clearHardEscalationTimer(cell);
    if (result.kind !== "yielded") {
      emit({
        type: "cell_finished",
        cellId: cell.cellId,
        success: result.kind === "completed",
        durationMs: result.durationMs,
      });
    }

    if (cell.timedOut) {
      cleanupCell(cell);
      const worker = cell.worker;
      cell.worker = null;
      void stopWorker(worker);
      return;
    }

    if (cell.waiter) {
      const waiter = cell.waiter;
      cell.waiter = undefined;
      waiter.resolve(result);
      if (result.kind !== "yielded") {
        cleanupCell(cell);
        const worker = cell.worker;
        cell.worker = null;
        void stopWorker(worker);
      }
      return;
    }

    if (result.kind === "yielded") {
      return;
    }

    cell.parkedResult = result;
    const worker = cell.worker;
    cell.worker = null;
    void stopWorker(worker);
  };

  const finalizeYield = (cell: CellState) => {
    if (!cell.waiter) return;
    clearYieldTimer(cell);
    clearSoftTimeoutTimer(cell);
    clearHardEscalationTimer(cell);
    const reason = cell.yieldedReason ?? "yield_control";
    const result = buildYieldedResult(cell, reason);
    const waiter = cell.waiter;
    cell.waiter = undefined;
    waiter.resolve(result);
    emit({
      type: "cell_yielded",
      cellId: cell.cellId,
      reason,
      durationMs: result.durationMs,
    });
  };

  const armYieldTimer = (cell: CellState, ms: number) => {
    clearYieldTimer(cell);
    cell.yieldTimer = setTimeout(() => {
      if (!cells.has(cell.cellId) || !cell.waiter) return;
      cell.yieldedReason = cell.yieldedReason ?? "pragma";
      finalizeYield(cell);
    }, ms);
    cell.yieldTimer.unref?.();
  };

  const armSoftTimeout = (cell: CellState, timeoutMs: number) => {
    cell.softTimeoutTimer = setTimeout(() => {
      if (!cells.has(cell.cellId) || cell.timedOut) return;
      cell.softTimeoutTimer = undefined;
      cell.timedOut = true;
      const result = buildFailedResult(
        cell,
        "execute",
        `Exec timed out after ${timeoutMs}ms.`,
      );
      const waiter = cell.waiter;
      cell.waiter = undefined;
      if (waiter) {
        waiter.resolve(result);
        emit({
          type: "cell_finished",
          cellId: cell.cellId,
          success: false,
          durationMs: result.durationMs,
        });
      }
      cell.hardEscalationTimer = setTimeout(() => {
        if (!cells.has(cell.cellId)) return;
        cleanupCell(cell);
        const worker = cell.worker;
        cell.worker = null;
        void stopWorker(worker);
      }, hardTerminationGraceMs);
      cell.hardEscalationTimer.unref?.();
    }, timeoutMs);
    cell.softTimeoutTimer.unref?.();
  };

  const handleWorkerCrash = (worker: Worker, reason: string) => {
    const cellId = workerToCellId.get(worker);
    if (!cellId) return;
    const cell = cells.get(cellId);
    workerToCellId.delete(worker);
    activeWorkers.delete(worker);
    if (!cell) return;
    cell.worker = null;
    parkOrDeliverTerminalResult(cell, buildFailedResult(cell, "host", reason));
  };

  const spawnWorker = async (): Promise<Worker> => {
    const scriptPath = await resolveWorkerScriptPath();
    const worker = new Worker(scriptPath, {
      stdout: false,
      stderr: false,
    });

    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          (message as { type?: string }).type === "ready"
        ) {
          worker.off("message", onMessage);
          worker.off("error", onError);
          resolve();
        }
      };
      const onError = (error: Error) => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        reject(error);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
    });

    activeWorkers.add(worker);
    worker.on("message", (message: WorkerToHostMessage) => {
      void handleWorkerMessage(worker, message);
    });
    worker.on("error", (error) => {
      handleWorkerCrash(worker, `Worker error: ${error.message}`);
    });
    worker.on("exit", (code) => {
      if (!workerToCellId.has(worker)) {
        activeWorkers.delete(worker);
        return;
      }
      handleWorkerCrash(
        worker,
        code === 0
          ? "Worker exited unexpectedly."
          : `Worker exited with code ${code}.`,
      );
    });
    return worker;
  };

  const handleToolCall = async (
    sourceWorker: Worker,
    message: {
      requestId: string;
      cellId: string;
      toolName: string;
      args: unknown;
    },
  ) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.worker !== sourceWorker) {
      sourceWorker.postMessage({
        type: "tool_result",
        requestId: message.requestId,
        error: `Cell ${message.cellId} is no longer active.`,
      });
      return;
    }

    const tool = cell.enabledToolsByName.get(message.toolName);
    if (!tool) {
      sourceWorker.postMessage({
        type: "tool_result",
        requestId: message.requestId,
        error: `Tool '${message.toolName}' is not available to this agent.`,
      });
      emit({
        type: "tool_result",
        cellId: cell.cellId,
        toolName: message.toolName,
        durationMs: 0,
        error: `Tool '${message.toolName}' is not available to this agent.`,
      });
      return;
    }

    const callRecord: ExecToolCallRecord = {
      toolName: tool.name,
      args: ensureJsonSerializable(message.args),
    };
    cell.toolCalls.push(callRecord);

    emit({
      type: "tool_call",
      cellId: cell.cellId,
      toolName: tool.name,
      argsPreview: previewUnknown(message.args),
    });

    const startedAt = Date.now();
    try {
      const value = await tool.handler(message.args, cell.context, {
        cellId: cell.cellId,
        ...(cell.toolHandlerExtras?.signal
          ? { signal: cell.toolHandlerExtras.signal }
          : {}),
      });
      const durationMs = Date.now() - startedAt;
      const serialized = ensureJsonSerializable(value);
      callRecord.result = serialized;
      sourceWorker.postMessage({
        type: "tool_result",
        requestId: message.requestId,
        value: serialized,
      });
      emit({
        type: "tool_result",
        cellId: cell.cellId,
        toolName: tool.name,
        durationMs,
        resultPreview: previewUnknown(serialized),
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      callRecord.error = errorMessage;
      sourceWorker.postMessage({
        type: "tool_result",
        requestId: message.requestId,
        error: errorMessage,
      });
      emit({
        type: "tool_result",
        cellId: cell.cellId,
        toolName: tool.name,
        durationMs,
        error: errorMessage,
      });
    }
  };

  const handleContent = (
    sourceWorker: Worker,
    message: { cellId: string; item: ExecContentItem },
  ) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.worker !== sourceWorker) return;
    cell.content.push(message.item);
    emit({
      type: "content",
      cellId: cell.cellId,
      item: message.item,
    });
  };

  const handleNotify = (
    sourceWorker: Worker,
    message: { cellId: string; text: string },
  ) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.worker !== sourceWorker) return;
    emit({
      type: "notify",
      cellId: cell.cellId,
      text: message.text,
    });
  };

  const handleStateSet = (
    sourceWorker: Worker,
    message: { cellId: string; key: string; value: unknown },
  ) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.worker !== sourceWorker) return;
    getConversationStore(cell.context.conversationId).set(
      message.key,
      ensureJsonSerializable(message.value),
    );
  };

  const handleYield = (
    sourceWorker: Worker,
    message: { cellId: string; requestId: string },
  ) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.worker !== sourceWorker) return;
    cell.yieldRequestId = message.requestId;
    cell.yieldedReason = cell.yieldedReason ?? "yield_control";
    finalizeYield(cell);
  };

  const handleResult = (
    sourceWorker: Worker,
    message: {
      cellId: string;
      success: boolean;
      value?: unknown;
      message?: string;
      phase?: ExecCellPhase;
    },
  ) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.worker !== sourceWorker) return;
    const result = message.success
      ? buildCompletedResult(cell, message.value)
      : buildFailedResult(
          cell,
          message.phase ?? "execute",
          message.message ?? "Unknown error",
        );
    parkOrDeliverTerminalResult(cell, result);
  };

  const handleWorkerMessage = async (
    sourceWorker: Worker,
    message: WorkerToHostMessage,
  ) => {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "tool_call":
        await handleToolCall(sourceWorker, message);
        break;
      case "content":
        handleContent(sourceWorker, message);
        break;
      case "notify":
        handleNotify(sourceWorker, message);
        break;
      case "state_set":
        handleStateSet(sourceWorker, message);
        break;
      case "yield":
        handleYield(sourceWorker, message);
        break;
      case "result":
        handleResult(sourceWorker, message);
        break;
      default:
        break;
    }
  };

  const execute = async (
    request: ExecuteRequest,
  ): Promise<ExecCellResult> => {
    const cellId = request.cellId ?? newCellId();
    const agentType =
      request.context.agentType ?? request.agentType ?? options.agentType;
    const enabledTools = options.registry.list(
      agentType ? { agentType } : undefined,
    );
    const worker = await spawnWorker();

    emit({
      type: "cell_started",
      cellId,
      summary: request.summary,
    });

    const cell: CellState = {
      cellId,
      startedAt: Date.now(),
      worker,
      waiter: undefined,
      context: request.context,
      ...(request.toolHandlerExtras
        ? { toolHandlerExtras: request.toolHandlerExtras }
        : {}),
      enabledToolsByName: new Map(enabledTools.map((tool) => [tool.name, tool])),
      content: [],
      toolCalls: [],
    };
    cells.set(cellId, cell);
    workerToCellId.set(worker, cellId);

    const pragma = parsePragma(request.source);
    const yieldAfterMs =
      request.yieldAfterMs ??
      pragma.yieldAfterMs ??
      options.defaultYieldAfterMs;
    if (typeof yieldAfterMs === "number" && yieldAfterMs > 0) {
      armYieldTimer(cell, yieldAfterMs);
    }

    const timeoutMs = Math.max(
      1_000,
      Math.min(
        request.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
    );
    armSoftTimeout(cell, timeoutMs);

    const resultPromise = new Promise<ExecCellResult>((resolve) => {
      cell.waiter = { resolve };
    });

    worker.postMessage({
      type: "execute",
      cellId,
      source: request.source,
      enabledTools: enabledTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      storeEntries: snapshotConversationStore(request.context),
    });

    return resultPromise;
  };

  const wait = async (request: WaitRequest): Promise<ExecCellResult> => {
    const cell = cells.get(request.cellId);
    if (!cell) {
      throw new Error(`No active Exec cell with id ${request.cellId}.`);
    }
    if (cell.parkedResult) {
      const parked = cell.parkedResult;
      cleanupCell(cell);
      return parked;
    }
    if (request.terminate) {
      const result = buildFailedResult(
        cell,
        "execute",
        "Cell terminated by Wait({ terminate: true }).",
      );
      cleanupCell(cell);
      const worker = cell.worker;
      cell.worker = null;
      void stopWorker(worker);
      emit({
        type: "cell_finished",
        cellId: cell.cellId,
        success: false,
        durationMs: result.durationMs,
      });
      return result;
    }
    if (cell.waiter) {
      throw new Error(`Exec cell ${request.cellId} is already waiting on Wait().`);
    }
    if (!cell.worker) {
      throw new Error(`Exec cell ${request.cellId} is no longer running.`);
    }

    const yieldAfterMs = request.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS;
    if (yieldAfterMs > 0) {
      armYieldTimer(cell, yieldAfterMs);
    }
    cell.startedAt = Date.now();
    cell.yieldedReason = "wait_request";

    const promise = new Promise<ExecCellResult>((resolve) => {
      cell.waiter = { resolve };
    });

    if (cell.yieldRequestId) {
      cell.worker.postMessage({
        type: "resume",
        requestId: cell.yieldRequestId,
        value: undefined,
      });
      cell.yieldRequestId = undefined;
    }

    return promise;
  };

  const shutdown = async () => {
    const workers = Array.from(activeWorkers);
    for (const cell of cells.values()) {
      clearYieldTimer(cell);
      clearHardEscalationTimer(cell);
      if (cell.waiter) {
        cell.waiter.resolve(
          buildFailedResult(cell, "host", "Exec host shut down."),
        );
      }
      cell.waiter = undefined;
      cell.worker = null;
      cell.parkedResult = undefined;
    }
    cells.clear();

    await Promise.allSettled(workers.map((worker) => stopWorker(worker)));
  };

  return {
    execute,
    wait,
    shutdown,
    getActiveCellIds: () => Array.from(cells.keys()),
  };
};

export type ExecHost = ReturnType<typeof createExecHost>;
