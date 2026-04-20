// @ts-nocheck
/**
 * Exec runtime worker. Runs inside a Node `worker_thread` and owns a single
 * V8 context that persists for the whole session.
 *
 * Each `Exec` request:
 *   1. compiles the program body with esbuild (TS -> async-IIFE wrapped CJS),
 *   2. installs / refreshes the `tools` global from the snapshot the host
 *      sent so newly registered tools appear without restarting the worker,
 *   3. runs the program inside the persistent context,
 *   4. ferries `tools.*` calls back to the host over `parentPort`.
 *
 * The worker is intentionally untyped (`@ts-nocheck`) so it can be loaded as a
 * single CommonJS bundle with the kernel's Node runtime — no extra TS build
 * step required at boot. Typed bridge code lives alongside in `exec-host.ts`.
 */

const vm = require("node:vm");
const fs = require("node:fs/promises");
const path = require("node:path");
const Module = require("node:module");
const { parentPort, workerData } = require("node:worker_threads");

if (!parentPort) {
  throw new Error("exec-worker.ts must be loaded as a worker_thread.");
}

// When the worker file lives outside the kernel's node_modules tree (the host
// transpiles it into the OS tmpdir on first launch), `require("esbuild")` won't
// resolve against the project. Push the host-known module paths into the
// shared `globalPaths` list so the worker can find them.
const nodeModulePaths: string[] = Array.isArray(workerData?.nodeModulePaths)
  ? (workerData.nodeModulePaths as string[])
  : [];
for (const entry of nodeModulePaths) {
  if (!Module.globalPaths.includes(entry)) {
    Module.globalPaths.push(entry);
  }
}

const requireFromKernel = (moduleId: string): unknown => {
  for (const candidateRoot of nodeModulePaths) {
    try {
      const created = Module.createRequire(path.join(candidateRoot, "noop.js"));
      return created(moduleId);
    } catch {
      // try the next root
    }
  }
  return require(moduleId);
};

const esbuild = requireFromKernel("esbuild") as typeof import("esbuild");

const sandbox = createSandbox();
const vmContext = vm.createContext(sandbox, {
  name: "stella-exec",
  codeGeneration: { strings: true, wasm: false },
});

const stored = new Map();
const pending = new Map();

let nextRequestId = 1;
const newRequestId = () => `req-${nextRequestId++}`;

function createSandbox() {
  const base = Object.create(null);
  const exposed = {
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
}

const sendToHost = (message) => {
  parentPort.postMessage(message);
};

const mimeForPath = (filePath) => {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
};

const stringifyText = (value) => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const installGlobals = (toolDefinitions, cellId) => {
  const tools = Object.create(null);
  for (const tool of toolDefinitions) {
    const toolName = tool.name;
    tools[toolName] = (args) =>
      new Promise((resolve, reject) => {
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
  vmContext.tools = tools;

  vmContext.ALL_TOOLS = Object.freeze(
    toolDefinitions.map((tool) =>
      Object.freeze({ name: tool.name, description: tool.description }),
    ),
  );

  vmContext.text = (value) => {
    sendToHost({
      type: "content",
      cellId,
      item: { type: "text", text: stringifyText(value) },
    });
  };

  vmContext.image = async (pathOrBuffer, options = {}) => {
    let buffer;
    let mime = options?.mime;
    if (Buffer.isBuffer(pathOrBuffer)) {
      buffer = pathOrBuffer;
    } else if (
      pathOrBuffer &&
      typeof pathOrBuffer === "object" &&
      typeof pathOrBuffer.path === "string"
    ) {
      buffer = await fs.readFile(pathOrBuffer.path);
      mime = mime ?? mimeForPath(pathOrBuffer.path);
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

  vmContext.store = (key, value) => {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("store(key, value) requires a non-empty string key.");
    }
    stored.set(key, value);
    return value;
  };

  vmContext.load = (key) => {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("load(key) requires a non-empty string key.");
    }
    return stored.get(key);
  };

  vmContext.notify = (text) => {
    sendToHost({
      type: "notify",
      cellId,
      text: stringifyText(text),
    });
  };

  vmContext.yield_control = () =>
    new Promise((resolve) => {
      const requestId = newRequestId();
      pending.set(requestId, { resolve, reject: resolve });
      sendToHost({ type: "yield", cellId, requestId });
    });

  vmContext.exit = (value) => {
    const error = new Error("__stella_exec_exit__");
    error.__stellaExit = true;
    error.value = value;
    throw error;
  };
};

const STATIC_IMPORT_RE = /^[\t ]*(import|export)\s/m;

const compileProgram = async (source) => {
  if (STATIC_IMPORT_RE.test(source)) {
    throw new Error(
      "Static import/export are not supported in Exec. Use require() or await import() instead.",
    );
  }
  // Wrap the body in an async IIFE so top-level await + return are legal.
  // We escape `*/` inside the body so the closing comment in the wrapper
  // can't be ended early.
  const safeBody = String(source).replace(/\*\//g, "*\\/");
  const wrappedSource =
    `module.exports = (async function __stella_exec_cell__() {\n` +
    `${safeBody}\n` +
    `})();`;
  const transformed = await esbuild.transform(wrappedSource, {
    loader: "ts",
    format: "cjs",
    target: "node22",
    sourcemap: "inline",
    sourcefile: "exec-cell.ts",
  });
  return new vm.Script(transformed.code, { filename: "exec-cell.js" });
};

const serialize = (value) => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

const handleExecute = async (request) => {
  installGlobals(request.enabledTools ?? [], request.cellId);

  let script;
  try {
    script = await compileProgram(String(request.source ?? ""));
  } catch (error) {
    sendToHost({
      type: "result",
      cellId: request.cellId,
      success: false,
      phase: "compile",
      message: error?.message ?? String(error),
    });
    return;
  }

  // Each cell gets its own `module.exports` slot so we can read back the
  // promise the wrapped IIFE returns. The vm context is shared across cells
  // (so `store`/`load` persists), but `module` is reset each run.
  vmContext.module = { exports: undefined };

  try {
    script.runInContext(vmContext);
    const cellPromise = vmContext.module.exports;
    const value = await Promise.resolve(cellPromise);
    sendToHost({
      type: "result",
      cellId: request.cellId,
      success: true,
      value: serialize(value),
    });
  } catch (error) {
    if (error?.__stellaExit) {
      sendToHost({
        type: "result",
        cellId: request.cellId,
        success: true,
        value: serialize(error.value),
      });
    } else {
      sendToHost({
        type: "result",
        cellId: request.cellId,
        success: false,
        phase: "execute",
        message: error?.message ?? String(error),
        stack: error?.stack ? String(error.stack) : undefined,
      });
    }
  }
};

const handleToolResult = (message) => {
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  if (message.error) {
    entry.reject(new Error(message.error));
    return;
  }
  entry.resolve(message.value);
};

const handleResume = (message) => {
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  entry.resolve(message.value ?? undefined);
};

parentPort.on("message", (message) => {
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

sendToHost({ type: "ready", workerData });
