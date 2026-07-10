import type { MessagePort } from "node:worker_threads";

import { installBrowserWorkerApi } from "../browser-use/worker-api.js";
import type {
  BrowserMethod,
  NodeReplWorkerData,
  ParentToNodeReplWorkerMessage,
  SerializedError,
  SkyMethod,
  WorkerToNodeReplParentMessage,
} from "./protocol.js";

/**
 * Kept self-contained because the function body is stringified and started as
 * an eval worker. That makes the same entry work from Vitest source, compiled
 * Electron output, and bundled runtime chunks without a separate worker asset.
 */
const nodeReplWorkerMain = async (
  installBrowserApi: typeof installBrowserWorkerApi,
) => {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<unknown>;
  const { parentPort, workerData } = (await dynamicImport(
    "node:worker_threads",
  )) as {
    parentPort: MessagePort | null;
    workerData: NodeReplWorkerData;
  };
  const os = (await dynamicImport("node:os")) as typeof import("node:os");
  const path = (await dynamicImport("node:path")) as typeof import("node:path");
  const replModule = (await dynamicImport(
    "node:repl",
  )) as typeof import("node:repl") & {
    default?: typeof import("node:repl");
  };
  const repl: typeof import("node:repl") =
    typeof replModule.start === "function" ? replModule : replModule.default!;
  const { createRequire, syncBuiltinESMExports } = (await dynamicImport(
    "node:module",
  )) as typeof import("node:module");
  const { PassThrough, Writable } = (await dynamicImport(
    "node:stream",
  )) as typeof import("node:stream");
  const { fileURLToPath } = (await dynamicImport(
    "node:url",
  )) as typeof import("node:url");
  const { formatWithOptions, inspect } = (await dynamicImport(
    "node:util",
  )) as typeof import("node:util");

  if (!parentPort) throw new Error("Node REPL worker requires a parent port.");

  const kernelRequire = createRequire(workerData.moduleUrl);
  const BLOCKED_NODE_MODULES = new Set([
    "child_process",
    "node:child_process",
    "process",
    "node:process",
    "worker_threads",
    "node:worker_threads",
  ]);
  const blockedCapability = (name: string) => {
    const blocked = function blockedNodeReplCapability() {
      throw new Error(`Direct process access is blocked in node_repl: ${name}`);
    };
    return blocked;
  };
  const lockValue = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      value,
      enumerable: descriptor?.enumerable ?? false,
      writable: false,
      configurable: false,
    });
  };

  // Source filtering is only an early diagnostic because user code can build
  // module names dynamically. Lock the worker-local builtin exports before the
  // REPL starts so import(), createRequire(), Module._load, and vm code all see
  // the same disabled process capabilities.
  const childProcessBuiltin = kernelRequire("node:child_process") as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(childProcessBuiltin)) {
    if (typeof childProcessBuiltin[key] === "function") {
      lockValue(
        childProcessBuiltin,
        key,
        blockedCapability(`node:child_process.${key}`),
      );
    }
  }
  Object.freeze(childProcessBuiltin);

  const workerThreadsBuiltin = kernelRequire("node:worker_threads") as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(workerThreadsBuiltin)) {
    if (typeof workerThreadsBuiltin[key] === "function") {
      lockValue(
        workerThreadsBuiltin,
        key,
        blockedCapability(`node:worker_threads.${key}`),
      );
    }
  }
  lockValue(workerThreadsBuiltin, "parentPort", undefined);
  lockValue(workerThreadsBuiltin, "workerData", undefined);
  Object.freeze(workerThreadsBuiltin);

  const processBuiltin = kernelRequire("node:process") as Record<
    string,
    unknown
  >;
  for (const key of [
    "_linkedBinding",
    "binding",
    "chdir",
    "dlopen",
    "getBuiltinModule",
    "initgroups",
    "kill",
    "setegid",
    "seteuid",
    "setgid",
    "setgroups",
    "setuid",
  ]) {
    if (key in processBuiltin) {
      lockValue(processBuiltin, key, blockedCapability(`node:process.${key}`));
    }
  }
  lockValue(processBuiltin, "mainModule", undefined);
  syncBuiltinESMExports();

  const SKY_METHODS: readonly SkyMethod[] = [
    "list_apps",
    "list_windows",
    "get_app_state",
    "click",
    "drag",
    "perform_secondary_action",
    "press_key",
    "scroll",
    "select_text",
    "set_value",
    "type_text",
    "batch",
  ];
  const OUTPUT_TRUNCATED = "\n...[output truncated]";

  const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
  const truncateUtf8 = (value: string, maxBytes: number): string => {
    if (byteLength(value) <= maxBytes) return value;
    const suffixBytes = byteLength(OUTPUT_TRUNCATED);
    const bodyBytes = Math.max(0, maxBytes - suffixBytes);
    return `${Buffer.from(value).subarray(0, bodyBytes).toString("utf8")}${OUTPUT_TRUNCATED}`;
  };
  const serializedSize = (value: unknown): number => {
    try {
      return byteLength(JSON.stringify(value) ?? "");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const serializeError = (error: unknown): SerializedError => {
    if (error instanceof Error) {
      return {
        name: truncateUtf8(error.name || "Error", 256),
        message: truncateUtf8(error.message || String(error), 16_384),
        ...(error.stack ? { stack: truncateUtf8(error.stack, 65_536) } : {}),
      };
    }
    return { name: "Error", message: truncateUtf8(String(error), 16_384) };
  };
  const post = (message: WorkerToNodeReplParentMessage) =>
    parentPort.postMessage(message);

  let activeEvaluationId: number | null = null;
  let writes: string[] | null = null;
  let writeBytes = 0;
  let outputBuffer = "";
  let outputErrorReject: ((error: Error) => void) | undefined;
  let nextSkyCallId = 1;
  let nextBrowserCallId = 1;
  const pendingSkyCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const pendingBrowserCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  const callSky = (method: SkyMethod, args: unknown[]): Promise<unknown> => {
    if (activeEvaluationId === null) {
      return Promise.reject(
        new Error(
          "sky methods may only be called during node_repl evaluation.",
        ),
      );
    }
    if (pendingSkyCalls.size >= workerData.maxPendingSkyCalls) {
      return Promise.reject(new Error("Too many pending sky calls."));
    }
    if (serializedSize(args) > workerData.maxProtocolMessageBytes) {
      return Promise.reject(
        new Error("sky call arguments exceed the protocol limit."),
      );
    }

    const callId = nextSkyCallId++;
    return new Promise((resolve, reject) => {
      pendingSkyCalls.set(callId, { resolve, reject });
      try {
        post({
          type: "sky-call",
          evaluationId: activeEvaluationId!,
          callId,
          method,
          args,
        });
      } catch (error) {
        pendingSkyCalls.delete(callId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const skyEntries = SKY_METHODS.map((method) => [
    method,
    (...args: unknown[]) => callSky(method, args),
  ]);
  const sky = Object.freeze(Object.fromEntries(skyEntries));

  const callBrowser = (
    method: BrowserMethod,
    args: readonly unknown[],
  ): Promise<unknown> => {
    if (activeEvaluationId === null) {
      return Promise.reject(
        new Error(
          "browser methods may only be called during node_repl evaluation.",
        ),
      );
    }
    if (pendingBrowserCalls.size >= workerData.maxPendingBrowserCalls) {
      return Promise.reject(new Error("Too many pending browser calls."));
    }
    if (method !== "command" && method !== "chain") {
      return Promise.reject(new Error("Invalid browser method."));
    }
    if (serializedSize(args) > workerData.maxProtocolMessageBytes) {
      return Promise.reject(
        new Error("browser call arguments exceed the protocol limit."),
      );
    }

    const callId = nextBrowserCallId++;
    return new Promise((resolve, reject) => {
      pendingBrowserCalls.set(callId, { resolve, reject });
      try {
        post({
          type: "browser-call",
          evaluationId: activeEvaluationId!,
          callId,
          method,
          args: [...args],
        });
      } catch (error) {
        pendingBrowserCalls.delete(callId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const browser = installBrowserApi(callBrowser);

  const write = (...values: unknown[]) => {
    if (!writes) {
      throw new Error("nodeRepl.write may only be called during evaluation.");
    }
    const rendered = formatWithOptions({ colors: false, depth: 6 }, ...values);
    const separatorBytes = writes.length > 0 ? 1 : 0;
    const remaining =
      workerData.maxEvalOutputBytes - writeBytes - separatorBytes;
    if (remaining <= 0) return;
    const bounded = truncateUtf8(rendered, remaining);
    writes.push(bounded);
    writeBytes += separatorBytes + byteLength(bounded);
  };
  const emitImage = (filePath: string) => {
    if (typeof filePath !== "string") {
      throw new Error(
        "nodeRepl.emitImage requires an absolute file path or file:// URL.",
      );
    }
    let absolutePath: string;
    try {
      absolutePath = filePath.startsWith("file://")
        ? fileURLToPath(filePath)
        : filePath;
    } catch {
      throw new Error("nodeRepl.emitImage received an invalid file:// URL.");
    }
    if (!path.isAbsolute(absolutePath)) {
      throw new Error(
        "nodeRepl.emitImage requires an absolute file path or file:// URL.",
      );
    }
    const marker = `[stella-attach-image] path=${JSON.stringify(absolutePath)}`;
    write(marker);
    return marker;
  };
  const home = os.homedir();
  const tmp = os.tmpdir();
  const nodeRepl = Object.freeze({
    cwd: workerData.cwd,
    home,
    tmp,
    homeDir: home,
    tmpDir: tmp,
    write,
    emitImage,
  });

  const input = new PassThrough();
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (outputErrorReject && chunk) {
        outputBuffer = truncateUtf8(
          outputBuffer + String(chunk),
          Math.min(workerData.maxEvalOutputBytes, 65_536),
        );
        if (
          /(?:^|\n)(?:Uncaught\b|(?:SyntaxError|ReferenceError|TypeError|RangeError|Error):)/.test(
            outputBuffer,
          )
        ) {
          const reject = outputErrorReject;
          outputErrorReject = undefined;
          reject(new Error(outputBuffer.trim()));
        }
      }
      done();
    },
  });
  const server = repl.start({
    input,
    output,
    prompt: "",
    terminal: false,
    useGlobal: false,
    ignoreUndefined: true,
  });
  const guardedRequire = (specifier: string) => {
    if (BLOCKED_NODE_MODULES.has(specifier)) {
      throw new Error(
        `Direct process access is blocked in node_repl: ${specifier}`,
      );
    }
    return kernelRequire(specifier);
  };
  Object.defineProperties(server.context, {
    nodeRepl: {
      value: nodeRepl,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    sky: {
      value: sky,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    browser: {
      value: browser,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    process: {
      value: undefined,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    require: {
      value: guardedRequire,
      enumerable: false,
      writable: false,
      configurable: false,
    },
  });

  const finishEvaluation = () => {
    activeEvaluationId = null;
    pendingSkyCalls.clear();
    pendingBrowserCalls.clear();
    writes = null;
    writeBytes = 0;
    outputBuffer = "";
    outputErrorReject = undefined;
  };

  const evaluate = async (evaluationId: number, code: string) => {
    if (activeEvaluationId !== null) {
      post({
        type: "evaluation-error",
        evaluationId,
        error: serializeError(
          new Error("Node REPL worker is already evaluating."),
        ),
      });
      return;
    }

    activeEvaluationId = evaluationId;
    writes = [];
    writeBytes = 0;
    outputBuffer = "";
    try {
      const rendered = await new Promise<string>((resolve, reject) => {
        outputErrorReject = reject;
        server.eval(code, server.context, "node_repl", (error, value) => {
          outputErrorReject = undefined;
          if (error) {
            reject(error);
            return;
          }
          resolve(
            value === undefined
              ? ""
              : inspect(value, {
                  colors: false,
                  depth: 6,
                  maxArrayLength: 100,
                  maxStringLength: 100_000,
                }),
          );
        });
      });
      const lines = writes ?? [];
      if (rendered) lines.push(rendered);
      post({
        type: "evaluation-result",
        evaluationId,
        output: truncateUtf8(lines.join("\n"), workerData.maxEvalOutputBytes),
      });
    } catch (error) {
      post({
        type: "evaluation-error",
        evaluationId,
        error: serializeError(error),
      });
    } finally {
      finishEvaluation();
    }
  };

  parentPort.on("message", (message: ParentToNodeReplWorkerMessage) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "evaluate") {
      if (
        !Number.isSafeInteger(message.evaluationId) ||
        typeof message.code !== "string" ||
        byteLength(message.code) > workerData.maxCodeBytes
      ) {
        post({
          type: "evaluation-error",
          evaluationId: message.evaluationId,
          error: serializeError(
            new Error("Invalid or oversized evaluation request."),
          ),
        });
        return;
      }
      void evaluate(message.evaluationId, message.code);
      return;
    }
    if (message.type === "sky-result") {
      const pending = pendingSkyCalls.get(message.callId);
      if (!pending) return;
      pendingSkyCalls.delete(message.callId);
      if (message.ok) pending.resolve(message.value);
      else {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        if (message.error.stack) error.stack = message.error.stack;
        pending.reject(error);
      }
      return;
    }
    if (message.type === "browser-result") {
      const pending = pendingBrowserCalls.get(message.callId);
      if (!pending) return;
      pendingBrowserCalls.delete(message.callId);
      if (message.ok) pending.resolve(message.value);
      else {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        if (message.error.stack) error.stack = message.error.stack;
        pending.reject(error);
      }
    }
  });

  post({ type: "ready" });
};

export const createNodeReplWorkerSource = (): string =>
  `const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });\n(${nodeReplWorkerMain.toString()})((${installBrowserWorkerApi.toString()})).catch((error) => setImmediate(() => { throw error; }))`;
