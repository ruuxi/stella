/**
 * Exec runtime worker. Runs inside a worker thread (Bun's `node:worker_threads`
 * shim in production, Node's worker_threads in tests). Each cell evaluates
 * inside its OWN fresh `vm.createContext` so cells can't pollute each other's
 * globals (Codex-style isolation per call).
 *
 * What persists while this worker is alive:
 *   - `stored`: the per-cell `Map` backing `store(k,v)` / `load(k)`, seeded
 *     from the host's conversation-scoped snapshot when the cell starts.
 *     Every `store(...)` also emits a `state_set` message so the host can
 *     persist the latest JSON-serializable value outside the worker.
 *   - `pending`: in-flight tool-call promise resolvers, keyed by requestId.
 *     A single requestId only ever belongs to one cell, so this is safe.
 *   - `nextRequestId`: monotonic counter (no semantic per-cell meaning).
 *
 * What does NOT persist across cells:
 *   - The cell's `globalThis`. Each cell gets a brand-new sandbox with the
 *     same Node-global surface (Buffer, process, fetch, require, ...) but a
 *     fresh global object. Mutations to globalThis from one cell do not leak
 *     into the next.
 *
 * Each `Exec` request:
 *   1. builds a fresh sandbox + `vm.createContext` for this cell,
 *   2. installs the `tools.*` global (rebuilt every call from the host's
 *      snapshot so newly registered tools appear without restarting the
 *      worker) plus the standard `text` / `image` / `store` / `load` /
 *      `notify` / `yield_control` / `exit` / `ALL_TOOLS` globals,
 *   3. compiles the program body with esbuild (TS -> async-IIFE wrapped CJS),
 *   4. runs the program inside the per-cell context,
 *   5. ferries `tools.*` calls back to the host via `parentPort.postMessage`.
 *
 * The worker is loaded as a normal in-tree TS module under Bun (no esbuild
 * bootstrap). Under Node — only used by vitest — the host transpiles this
 * file to an in-tree CJS cache so module resolution still picks up esbuild
 * from `runtime/node_modules`. No tmpdir, no `Module.globalPaths` patching.
 */

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { parentPort } from "node:worker_threads";
import { transform } from "esbuild";

if (!parentPort) {
  throw new Error("exec-worker.ts must be loaded as a worker thread.");
}

const port = parentPort;

type ToolDefinitionLike = { name: string; description?: string };

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

type WorkerInbound =
  | {
      type: "execute";
      cellId: string;
      source?: string;
      enabledTools?: ToolDefinitionLike[];
      storeEntries?: Array<[string, unknown]>;
    }
  | { type: "tool_result"; requestId: string; value?: unknown; error?: string }
  | { type: "resume"; requestId: string; value?: unknown }
  | { type: "shutdown" };

type WorkerOutbound =
  | { type: "ready" }
  | {
      type: "tool_call";
      requestId: string;
      cellId: string;
      toolName: string;
      args: unknown;
    }
  | { type: "content"; cellId: string; item: ContentItem }
  | { type: "notify"; cellId: string; text: string }
  | { type: "state_set"; cellId: string; key: string; value: unknown }
  | { type: "yield"; cellId: string; requestId: string }
  | {
      type: "result";
      cellId: string;
      success: boolean;
      value?: unknown;
      message?: string;
      phase?: "compile" | "execute";
      stack?: string;
    };

type StellaExitError = Error & { __stellaExit: true; value: unknown };

let stored = new Map<string, unknown>();
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>();

let nextRequestId = 1;
const newRequestId = () => `req-${nextRequestId++}`;

const sendToHost = (message: WorkerOutbound) => {
  port.postMessage(message);
};

const createSandbox = (): Record<string, unknown> => {
  const base: Record<string, unknown> = Object.create(null);
  const exposed: Record<string, unknown> = {
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    URL,
    URLSearchParams,
    fetch: typeof fetch === "function" ? fetch : undefined,
    Headers: typeof Headers === "function" ? Headers : undefined,
    Request: typeof Request === "function" ? Request : undefined,
    Response: typeof Response === "function" ? Response : undefined,
    crypto: typeof crypto !== "undefined" ? crypto : undefined,
    TextEncoder,
    TextDecoder,
    require,
  };
  for (const [key, value] of Object.entries(exposed)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  base.global = base;
  base.globalThis = base;
  return base;
};

const createCellContext = (cellId: string): vm.Context => {
  const sandbox = createSandbox();
  return vm.createContext(sandbox, {
    name: `stella-exec-${cellId}`,
    codeGeneration: { strings: true, wasm: false },
  });
};

const mimeForPath = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
};

const stringifyText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const installGlobals = (
  vmContext: vm.Context,
  toolDefinitions: ToolDefinitionLike[],
  cellId: string,
) => {
  const ctx = vmContext as Record<string, unknown>;
  const tools: Record<string, (args?: unknown) => Promise<unknown>> =
    Object.create(null);
  for (const tool of toolDefinitions) {
    const toolName = tool.name;
    tools[toolName] = (args?: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const requestId = newRequestId();
        pending.set(requestId, { resolve, reject });
        sendToHost({
          type: "tool_call",
          requestId,
          cellId,
          toolName,
          args: args === undefined ? null : args,
        });
      });
  }
  Object.freeze(tools);
  ctx.tools = tools;

  ctx.ALL_TOOLS = Object.freeze(
    toolDefinitions.map((tool) =>
      Object.freeze({ name: tool.name, description: tool.description }),
    ),
  );

  ctx.text = (value: unknown) => {
    sendToHost({
      type: "content",
      cellId,
      item: { type: "text", text: stringifyText(value) },
    });
  };

  ctx.image = async (
    pathOrBuffer: unknown,
    options: { mime?: string } = {},
  ) => {
    let buffer: Buffer;
    let mime = options?.mime;
    if (Buffer.isBuffer(pathOrBuffer)) {
      buffer = pathOrBuffer;
    } else if (
      pathOrBuffer &&
      typeof pathOrBuffer === "object" &&
      typeof (pathOrBuffer as { path?: unknown }).path === "string"
    ) {
      const p = (pathOrBuffer as { path: string }).path;
      buffer = await fs.readFile(p);
      mime = mime ?? mimeForPath(p);
    } else if (typeof pathOrBuffer === "string") {
      const resolved = path.isAbsolute(pathOrBuffer)
        ? pathOrBuffer
        : path.resolve(process.cwd(), pathOrBuffer);
      buffer = await fs.readFile(resolved);
      mime = mime ?? mimeForPath(resolved);
    } else {
      throw new Error(
        "image() expects an absolute path string, a Buffer, or { path }.",
      );
    }
    sendToHost({
      type: "content",
      cellId,
      item: {
        type: "image",
        mimeType: mime ?? "image/png",
        data: buffer.toString("base64"),
      },
    });
  };

  ctx.store = (key: unknown, value: unknown) => {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("store(key, value) requires a non-empty string key.");
    }
    stored.set(key, value);
    sendToHost({
      type: "state_set",
      cellId,
      key,
      value: serialize(value),
    });
    return value;
  };

  ctx.load = (key: unknown) => {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("load(key) requires a non-empty string key.");
    }
    return stored.get(key);
  };

  ctx.notify = (text: unknown) => {
    sendToHost({
      type: "notify",
      cellId,
      text: stringifyText(text),
    });
  };

  ctx.yield_control = () =>
    new Promise<unknown>((resolve) => {
      const requestId = newRequestId();
      pending.set(requestId, { resolve, reject: resolve });
      sendToHost({ type: "yield", cellId, requestId });
    });

  ctx.exit = (value: unknown) => {
    const error = new Error("__stella_exec_exit__") as StellaExitError;
    error.__stellaExit = true;
    error.value = value;
    throw error;
  };
};

const STATIC_IMPORT_RE = /^[\t ]*(import|export)\s/m;

const compileProgram = async (source: string): Promise<vm.Script> => {
  if (STATIC_IMPORT_RE.test(source)) {
    throw new Error(
      "Static import/export are not supported in Exec. Use require() or await import() instead.",
    );
  }
  // Wrap the body in an async IIFE so top-level await + return are legal.
  // We escape `*/` inside the body so the closing comment in the wrapper
  // can't be ended early.
  const safeBody = source.replace(/\*\//g, "*\\/");
  const wrappedSource =
    `module.exports = (async function __stella_exec_cell__() {\n` +
    `${safeBody}\n` +
    `})();`;
  const transformed = await transform(wrappedSource, {
    loader: "ts",
    format: "cjs",
    target: "node22",
    sourcemap: "inline",
    sourcefile: "exec-cell.ts",
  });
  return new vm.Script(transformed.code, { filename: "exec-cell.js" });
};

const serialize = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

const isStellaExit = (error: unknown): error is StellaExitError =>
  Boolean(
    error &&
      typeof error === "object" &&
      (error as { __stellaExit?: unknown }).__stellaExit === true,
  );

const handleExecute = async (
  request: Extract<WorkerInbound, { type: "execute" }>,
) => {
  stored = new Map(Array.isArray(request.storeEntries) ? request.storeEntries : []);
  // Fresh sandbox + V8 context per cell. No globals, prototype mutations, or
  // module-level state from a previous cell can leak in here. Tool calls and
  // store/load still work because they go through worker-scoped state.
  const vmContext = createCellContext(request.cellId);
  installGlobals(vmContext, request.enabledTools ?? [], request.cellId);

  let script: vm.Script;
  try {
    script = await compileProgram(String(request.source ?? ""));
  } catch (error) {
    sendToHost({
      type: "result",
      cellId: request.cellId,
      success: false,
      phase: "compile",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // The wrapped IIFE assigns its result promise into `module.exports`; we
  // read it back after the script runs synchronously.
  (vmContext as Record<string, unknown>).module = { exports: undefined };

  try {
    script.runInContext(vmContext);
    const cellPromise = (vmContext as { module: { exports: unknown } }).module
      .exports;
    const value = await Promise.resolve(cellPromise);
    sendToHost({
      type: "result",
      cellId: request.cellId,
      success: true,
      value: serialize(value),
    });
  } catch (error) {
    if (isStellaExit(error)) {
      sendToHost({
        type: "result",
        cellId: request.cellId,
        success: true,
        value: serialize(error.value),
      });
      return;
    }
    sendToHost({
      type: "result",
      cellId: request.cellId,
      success: false,
      phase: "execute",
      message: error instanceof Error ? error.message : String(error),
      stack:
        error instanceof Error && error.stack ? String(error.stack) : undefined,
    });
  }
};

const handleToolResult = (
  message: Extract<WorkerInbound, { type: "tool_result" }>,
) => {
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  if (message.error) {
    entry.reject(new Error(message.error));
    return;
  }
  entry.resolve(message.value);
};

const handleResume = (message: Extract<WorkerInbound, { type: "resume" }>) => {
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  entry.resolve(message.value ?? undefined);
};

port.on("message", (message: WorkerInbound) => {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "execute":
      void handleExecute(message);
      break;
    case "tool_result":
      handleToolResult(message);
      break;
    case "resume":
      handleResume(message);
      break;
    case "shutdown":
      process.exit(0);
      break;
    default:
      break;
  }
});

sendToHost({ type: "ready" });
