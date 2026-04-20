/**
 * Host for the Codex-style Exec runtime.
 *
 * Owns one long-lived Node `worker_thread` per session that hosts the V8
 * context. Each `Exec` call:
 *   - assigns a unique `cellId`
 *   - posts an `execute` message to the worker with the program source and a
 *     fresh snapshot of the registry's tool definitions
 *   - waits for `tool_call` messages to round-trip into the `ExecToolRegistry`
 *     and posts the results back
 *   - collects `text` / `image` `notify` updates into a content array
 *   - resolves to either `Result` (cell finished) or `Yielded` (cell suspended
 *     and is waiting for `Wait({ cell_id })`).
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { transform } from "esbuild";

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
const NODE_PATH_ENTRIES = [
  fileURLToPath(new URL("../../../node_modules", import.meta.url)),
  fileURLToPath(new URL("../../../desktop/node_modules", import.meta.url)),
].filter((entry, index, entries) => existsSync(entry) && entries.indexOf(entry) === index);

export type ExecCellPhase = "compile" | "execute" | "tool" | "host";

export type ExecCellResult =
  | {
      kind: "completed";
      cellId: string;
      value: unknown;
      content: ExecContentItem[];
      durationMs: number;
    }
  | {
      kind: "failed";
      cellId: string;
      phase: ExecCellPhase;
      message: string;
      content: ExecContentItem[];
      durationMs: number;
    }
  | {
      kind: "yielded";
      cellId: string;
      reason: "yield_control" | "pragma" | "wait_request";
      content: ExecContentItem[];
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

type CellState = {
  cellId: string;
  startedAt: number;
  resolve: (result: ExecCellResult) => void;
  reject: (error: Error) => void;
  context: ToolContext;
  toolHandlerExtras?: ToolHandlerExtras;
  enabledTools: ExecToolDefinition[];
  content: ExecContentItem[];
  yieldRequestId?: string;
  yieldedReason?: "yield_control" | "pragma" | "wait_request";
  yieldDeadline?: number;
  yieldTimer?: NodeJS.Timeout;
  resolved: boolean;
};

export type ExecHostOptions = {
  registry: ExecToolRegistry;
  agentType?: string;
  defaultTimeoutMs?: number;
  defaultYieldAfterMs?: number;
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

const PRAGMA_RE = /^[\t ]*\/\/\s*@exec:\s*([^\r\n]+)/m;

const parsePragma = (
  source: string,
): { yieldAfterMs?: number } => {
  // Look at the first non-empty line. The pragma is meaningful only when it
  // is the first directive of the cell, before any executable code.
  const firstNonEmpty = source.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
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

const buildWorkerEnv = (): NodeJS.ProcessEnv => {
  if (NODE_PATH_ENTRIES.length === 0) return process.env;
  const existing = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  return {
    ...process.env,
    NODE_PATH: [...NODE_PATH_ENTRIES, ...existing].join(path.delimiter),
  };
};

const buildTranspiledWorkerPath = (mtimeMs: number): string =>
  path.join(
    os.tmpdir(),
    "stella-exec",
    `exec-worker-${Math.floor(mtimeMs).toString(36)}.cjs`,
  );

const resolveWorkerScriptPath = async (): Promise<string> => {
  if (existsSync(EXEC_WORKER_JS_PATH)) {
    return EXEC_WORKER_JS_PATH;
  }
  if (!existsSync(EXEC_WORKER_TS_PATH)) {
    throw new Error("Exec worker source is missing.");
  }
  const stat = await fs.stat(EXEC_WORKER_TS_PATH);
  const transpiled = buildTranspiledWorkerPath(stat.mtimeMs);
  if (existsSync(transpiled)) {
    return transpiled;
  }
  const source = await fs.readFile(EXEC_WORKER_TS_PATH, "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: "inline",
  });
  await fs.mkdir(path.dirname(transpiled), { recursive: true });
  await fs.writeFile(transpiled, result.code, "utf8");
  return transpiled;
};

export const createExecHost = (options: ExecHostOptions) => {
  const cells = new Map<string, CellState>();

  let worker: Worker | undefined;
  let workerReady: Promise<Worker> | undefined;
  let nextCellId = 1;

  const newCellId = () => `cell-${(nextCellId++).toString(36)}`;

  const emit = (event: ExecHostEvent) => {
    options.onUpdate?.(event);
  };

  const ensureWorker = async (): Promise<Worker> => {
    if (worker) return worker;
    if (workerReady) return workerReady;

    workerReady = (async () => {
      const scriptPath = await resolveWorkerScriptPath();
      const w = new Worker(scriptPath, {
        env: buildWorkerEnv(),
        workerData: {
          nodeModulePaths: NODE_PATH_ENTRIES,
        },
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
            w.off("message", onMessage);
            w.off("error", onError);
            resolve();
          }
        };
        const onError = (error: Error) => {
          w.off("message", onMessage);
          w.off("error", onError);
          reject(error);
        };
        w.on("message", onMessage);
        w.on("error", onError);
      });
      w.on("message", (message: WorkerToHostMessage) => {
        handleWorkerMessage(message);
      });
      w.on("error", (error) => {
        for (const cell of cells.values()) {
          if (cell.resolved) continue;
          cell.resolved = true;
          cell.resolve({
            kind: "failed",
            cellId: cell.cellId,
            phase: "host",
            message: `Worker error: ${error.message}`,
            content: cell.content,
            durationMs: Date.now() - cell.startedAt,
          });
        }
        cells.clear();
        worker = undefined;
        workerReady = undefined;
      });
      worker = w;
      return w;
    })();
    return workerReady;
  };

  const handleWorkerMessage = async (message: WorkerToHostMessage) => {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "tool_call":
        await handleToolCall(message);
        break;
      case "content":
        handleContent(message);
        break;
      case "notify":
        handleNotify(message);
        break;
      case "yield":
        handleYield(message);
        break;
      case "result":
        handleResult(message);
        break;
      default:
        break;
    }
  };

  const handleToolCall = async (message: {
    requestId: string;
    cellId: string;
    toolName: string;
    args: unknown;
  }) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.resolved) {
      worker?.postMessage({
        type: "tool_result",
        requestId: message.requestId,
        error: `Cell ${message.cellId} is no longer active.`,
      });
      return;
    }
    const tool = options.registry.get(message.toolName);
    if (!tool) {
      worker?.postMessage({
        type: "tool_result",
        requestId: message.requestId,
        error: `Unknown tool: ${message.toolName}`,
      });
      emit({
        type: "tool_result",
        cellId: cell.cellId,
        toolName: message.toolName,
        durationMs: 0,
        error: `Unknown tool: ${message.toolName}`,
      });
      return;
    }
    const argsPreview = previewUnknown(message.args);
    emit({
      type: "tool_call",
      cellId: cell.cellId,
      toolName: tool.name,
      argsPreview,
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
      worker?.postMessage({
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
      worker?.postMessage({
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

  const handleContent = (message: {
    cellId: string;
    item: ExecContentItem;
  }) => {
    const cell = cells.get(message.cellId);
    if (!cell) return;
    cell.content.push(message.item);
    emit({
      type: "content",
      cellId: cell.cellId,
      item: message.item,
    });
  };

  const handleNotify = (message: { cellId: string; text: string }) => {
    const cell = cells.get(message.cellId);
    if (!cell) return;
    emit({
      type: "notify",
      cellId: cell.cellId,
      text: message.text,
    });
  };

  const handleYield = (message: { cellId: string; requestId: string }) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.resolved) return;
    cell.yieldRequestId = message.requestId;
    cell.yieldedReason = cell.yieldedReason ?? "yield_control";
    finalizeYield(cell);
  };

  const handleResult = (message: {
    cellId: string;
    success: boolean;
    value?: unknown;
    message?: string;
    phase?: ExecCellPhase;
  }) => {
    const cell = cells.get(message.cellId);
    if (!cell || cell.resolved) return;
    if (cell.yieldTimer) {
      clearTimeout(cell.yieldTimer);
    }
    cell.resolved = true;
    const durationMs = Date.now() - cell.startedAt;
    if (message.success) {
      cell.resolve({
        kind: "completed",
        cellId: cell.cellId,
        value: message.value,
        content: cell.content,
        durationMs,
      });
      emit({
        type: "cell_finished",
        cellId: cell.cellId,
        success: true,
        durationMs,
      });
    } else {
      cell.resolve({
        kind: "failed",
        cellId: cell.cellId,
        phase: message.phase ?? "execute",
        message: message.message ?? "Unknown error",
        content: cell.content,
        durationMs,
      });
      emit({
        type: "cell_finished",
        cellId: cell.cellId,
        success: false,
        durationMs,
      });
    }
    cells.delete(cell.cellId);
  };

  const finalizeYield = (cell: CellState) => {
    if (cell.resolved) return;
    cell.resolved = true;
    if (cell.yieldTimer) {
      clearTimeout(cell.yieldTimer);
    }
    const durationMs = Date.now() - cell.startedAt;
    const result: ExecCellResult = {
      kind: "yielded",
      cellId: cell.cellId,
      reason: cell.yieldedReason ?? "yield_control",
      content: cell.content,
      durationMs,
    };
    cell.resolve(result);
    emit({
      type: "cell_yielded",
      cellId: cell.cellId,
      reason: result.reason,
      durationMs,
    });
    // Cell stays in `cells` (with resolved=true reset to false for the next
    // resume) until `Wait` either resumes or terminates it. We mark it as
    // unresolved again so the next Result message can land.
    cell.resolved = false;
    cell.yieldDeadline = undefined;
    cell.yieldTimer = undefined;
  };

  const armPragmaTimer = (cell: CellState, ms: number) => {
    if (cell.yieldTimer) clearTimeout(cell.yieldTimer);
    cell.yieldDeadline = Date.now() + ms;
    cell.yieldTimer = setTimeout(() => {
      if (cell.resolved) return;
      cell.yieldedReason = "pragma";
      finalizeYield(cell);
    }, ms);
    cell.yieldTimer.unref?.();
  };

  const execute = async (
    request: ExecuteRequest,
  ): Promise<ExecCellResult> => {
    const cellId = request.cellId ?? newCellId();
    const enabledTools = options.registry.list(
      options.agentType
        ? { agentType: options.agentType }
        : request.agentType
          ? { agentType: request.agentType }
          : undefined,
    );
    emit({
      type: "cell_started",
      cellId,
      summary: request.summary,
    });

    const w = await ensureWorker();

    const promise = new Promise<ExecCellResult>((resolve, reject) => {
      const cell: CellState = {
        cellId,
        startedAt: Date.now(),
        resolve,
        reject,
        context: request.context,
        ...(request.toolHandlerExtras
          ? { toolHandlerExtras: request.toolHandlerExtras }
          : {}),
        enabledTools,
        content: [],
        resolved: false,
      };
      cells.set(cellId, cell);

      const pragma = parsePragma(request.source);
      const yieldAfterMs =
        request.yieldAfterMs ??
        pragma.yieldAfterMs ??
        options.defaultYieldAfterMs;
      if (typeof yieldAfterMs === "number" && yieldAfterMs > 0) {
        armPragmaTimer(cell, yieldAfterMs);
      }

      const timeoutMs = Math.max(
        1_000,
        Math.min(
          request.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
          MAX_TIMEOUT_MS,
        ),
      );
      const timeoutTimer = setTimeout(() => {
        if (cell.resolved) return;
        cell.resolved = true;
        cell.resolve({
          kind: "failed",
          cellId,
          phase: "execute",
          message: `Exec timed out after ${timeoutMs}ms.`,
          content: cell.content,
          durationMs: Date.now() - cell.startedAt,
        });
        cells.delete(cellId);
      }, timeoutMs);
      timeoutTimer.unref?.();
    });

    w.postMessage({
      type: "execute",
      cellId,
      source: request.source,
      enabledTools: enabledTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    });

    return promise;
  };

  const wait = async (request: WaitRequest): Promise<ExecCellResult> => {
    const cell = cells.get(request.cellId);
    if (!cell) {
      throw new Error(`No active Exec cell with id ${request.cellId}.`);
    }
    if (request.terminate) {
      if (cell.yieldRequestId) {
        worker?.postMessage({
          type: "resume",
          requestId: cell.yieldRequestId,
          value: { terminated: true },
        });
        cell.yieldRequestId = undefined;
      }
      cell.resolved = true;
      cells.delete(cell.cellId);
      const durationMs = Date.now() - cell.startedAt;
      const result: ExecCellResult = {
        kind: "failed",
        cellId: cell.cellId,
        phase: "execute",
        message: "Cell terminated by Wait({ terminate: true }).",
        content: cell.content,
        durationMs,
      };
      cell.resolve(result);
      return result;
    }

    return new Promise<ExecCellResult>((resolve) => {
      cell.resolve = resolve;
      cell.startedAt = Date.now();
      cell.resolved = false;
      cell.yieldedReason = "wait_request";

      const yieldAfterMs = request.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS;
      armPragmaTimer(cell, yieldAfterMs);

      if (cell.yieldRequestId) {
        worker?.postMessage({
          type: "resume",
          requestId: cell.yieldRequestId,
          value: undefined,
        });
        cell.yieldRequestId = undefined;
      }
    });
  };

  const shutdown = async () => {
    if (worker) {
      try {
        worker.postMessage({ type: "shutdown" });
        await worker.terminate();
      } catch {
        // Best-effort shutdown.
      }
      worker = undefined;
      workerReady = undefined;
    }
  };

  return {
    execute,
    wait,
    shutdown,
    getActiveCellIds: () => Array.from(cells.keys()),
  };
};

export type ExecHost = ReturnType<typeof createExecHost>;
