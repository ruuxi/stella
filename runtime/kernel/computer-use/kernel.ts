import path from "node:path";
import { Worker } from "node:worker_threads";

import type { ToolContext } from "../tools/types.js";
import { getStellaComputerSessionId } from "../tools/stella-computer-session.js";
import {
  createInProcessComputerCommandRunner,
  type ComputerCommandRunner,
  type StellaComputerExecutor,
} from "./command-runner.js";
import { createSkyClient, type SkyClient } from "./client.js";
import { createNodeReplWorkerSource } from "./kernel-worker.js";
import {
  MAX_NODE_REPL_CODE_BYTES,
  MAX_NODE_REPL_OUTPUT_BYTES,
  MAX_NODE_REPL_PENDING_SKY_CALLS,
  MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES,
  type NodeReplWorkerData,
  type ParentToNodeReplWorkerMessage,
  type SerializedError,
  type SkyMethod,
  type WorkerToNodeReplParentMessage,
} from "./protocol.js";

const DEFAULT_EVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 4 * 60 * 60_000;

export type NodeReplMetadata = Readonly<{
  cwd: string;
  home: string;
  tmp: string;
  homeDir: string;
  tmpDir: string;
  write: (...values: unknown[]) => void;
  emitImage: (filePath: string) => string;
}>;

export type NodeReplKernelManagerOptions = {
  cliPath?: string;
  runner?: ComputerCommandRunner;
  executor?: StellaComputerExecutor;
  disposeSession?: (sessionId: string) => void | Promise<void>;
  evalTimeoutMs?: number;
  commandTimeoutMs?: number;
  idleTimeoutMs?: number;
};

export type EvaluateOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

class KernelTerminatedError extends Error {}

const BLOCKED_NODE_MODULE_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(?:child_process|process|worker_threads)["']|process\s*\.\s*(?:binding|getBuiltinModule|dlopen)/;

const SKY_METHODS = new Set<SkyMethod>([
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
]);

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Node REPL evaluation aborted.");

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

const serializedSize = (value: unknown): number => {
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const serializeError = (error: unknown): SerializedError => {
  const truncate = (value: string, maxBytes: number) =>
    byteLength(value) <= maxBytes
      ? value
      : Buffer.from(value).subarray(0, maxBytes).toString("utf8");
  if (error instanceof Error) {
    return {
      name: truncate(error.name || "Error", 256),
      message: truncate(error.message || String(error), 16_384),
      ...(error.stack ? { stack: truncate(error.stack, 65_536) } : {}),
    };
  }
  return { name: "Error", message: truncate(String(error), 16_384) };
};

const deserializeError = (error: SerializedError): Error => {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
};

type ActiveEvaluation = {
  id: number;
  controller: AbortController;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
};

class NodeReplKernel {
  private readonly worker: Worker;
  private readonly sky: SkyClient;
  private readonly onTerminated: (kernel: NodeReplKernel) => void;
  private tail: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private pending = 0;
  private skyTail: Promise<void> = Promise.resolve();
  private nextEvaluationId = 1;
  private active: ActiveEvaluation | null = null;
  private closed = false;

  constructor(
    readonly id: string,
    cwd: string,
    options: Required<
      Pick<
        NodeReplKernelManagerOptions,
        "runner" | "evalTimeoutMs" | "commandTimeoutMs" | "idleTimeoutMs"
      >
    > & { cliPath?: string; onIdle: (kernel: NodeReplKernel) => void },
  ) {
    this.onTerminated = options.onIdle;
    this.sky = createSkyClient({
      cliPath: options.cliPath,
      sessionId: id,
      cwd,
      runner: options.runner,
      commandTimeoutMs: options.commandTimeoutMs,
      maxOutputBytes: MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES,
      getSignal: () => this.active?.controller.signal,
    });
    const workerData: NodeReplWorkerData = {
      cwd,
      moduleUrl: import.meta.url,
      maxCodeBytes: MAX_NODE_REPL_CODE_BYTES,
      maxEvalOutputBytes: MAX_NODE_REPL_OUTPUT_BYTES,
      maxProtocolMessageBytes: MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES,
      maxPendingSkyCalls: MAX_NODE_REPL_PENDING_SKY_CALLS,
    };
    const workerUrl = new URL(
      `data:text/javascript;base64,${Buffer.from(createNodeReplWorkerSource()).toString("base64")}`,
    );
    this.worker = new Worker(workerUrl, {
      workerData,
      name: `stella-node-repl-${id.slice(0, 48)}`,
    });
    this.worker.on("message", (message: unknown) =>
      this.handleMessage(message),
    );
    this.worker.on("error", (error) =>
      this.handleWorkerFailure(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        this.handleWorkerFailure(
          new Error(`Node REPL worker exited unexpectedly with code ${code}.`),
        );
      }
    });
    this.worker.unref();
    this.scheduleIdle(options.idleTimeoutMs, options.onIdle);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const active = this.active;
    if (active) {
      active.controller.abort(new Error("Node REPL kernel closed."));
      this.settleActive(
        active,
        new KernelTerminatedError("Node REPL kernel closed."),
      );
    }
    void this.worker.terminate().catch(() => undefined);
  }

  enqueue(
    code: string,
    options: EvaluateOptions,
    defaults: { evalTimeoutMs: number; idleTimeoutMs: number },
    onIdle: (kernel: NodeReplKernel) => void,
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new KernelTerminatedError("Kernel closed."));
    }
    if (byteLength(code) > MAX_NODE_REPL_CODE_BYTES) {
      return Promise.reject(
        new Error(
          `Node REPL input exceeds the ${MAX_NODE_REPL_CODE_BYTES}-byte limit.`,
        ),
      );
    }
    this.pending += 1;
    this.worker.ref();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const run = async () => {
      if (this.closed) throw new KernelTerminatedError("Kernel closed.");
      return await this.evaluate(
        code,
        options.timeoutMs ?? defaults.evalTimeoutMs,
        options.signal,
      );
    };
    const task = this.tail.then(run, run);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    const finish = () => {
      this.pending -= 1;
      if (!this.closed && this.pending === 0) {
        this.worker.unref();
        this.scheduleIdle(defaults.idleTimeoutMs, onIdle);
      }
    };
    void task.then(finish, finish);
    return task;
  }

  private scheduleIdle(
    timeoutMs: number,
    onIdle: (kernel: NodeReplKernel) => void,
  ) {
    this.idleTimer = setTimeout(() => onIdle(this), timeoutMs);
    this.idleTimer.unref();
  }

  private evaluate(
    code: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      return Promise.reject(
        new KernelTerminatedError(abortError(signal).message),
      );
    }
    if (BLOCKED_NODE_MODULE_RE.test(code)) {
      return Promise.reject(
        new Error(
          "Direct process spawning is blocked in node_repl; use sky for computer use or exec_command for explicit shell work.",
        ),
      );
    }

    return new Promise<string>((resolve, reject) => {
      const id = this.nextEvaluationId++;
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        this.terminateActive(
          new KernelTerminatedError(
            `Node REPL timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      const active: ActiveEvaluation = {
        id,
        controller,
        timeout,
        signal,
        resolve,
        reject,
      };
      this.active = active;
      if (signal) {
        active.onAbort = () => {
          this.terminateActive(
            new KernelTerminatedError(abortError(signal).message),
          );
        };
        signal.addEventListener("abort", active.onAbort, { once: true });
        if (signal.aborted) {
          active.onAbort();
          return;
        }
      }
      try {
        this.post({ type: "evaluate", evaluationId: id, code });
      } catch (error) {
        this.terminateActive(
          new KernelTerminatedError(
            `Failed to send Node REPL evaluation: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  private post(message: ParentToNodeReplWorkerMessage) {
    this.worker.postMessage(message);
  }

  private handleMessage(message: unknown) {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const typed = message as WorkerToNodeReplParentMessage;
    if (typed.type === "ready") return;
    if (typed.type === "sky-call") {
      const run = () => this.handleSkyCall(typed);
      const task = this.skyTail.then(run, run);
      this.skyTail = task.then(
        () => undefined,
        () => undefined,
      );
      return;
    }

    const active = this.active;
    if (!active || typed.evaluationId !== active.id) return;
    if (typed.type === "evaluation-result") {
      if (
        typeof typed.output !== "string" ||
        byteLength(typed.output) > MAX_NODE_REPL_OUTPUT_BYTES
      ) {
        this.terminateActive(
          new KernelTerminatedError(
            "Node REPL worker returned oversized output.",
          ),
        );
        return;
      }
      this.settleActive(active, null, typed.output);
      return;
    }
    if (typed.type === "evaluation-error") {
      this.settleActive(active, deserializeError(typed.error));
    }
  }

  private async handleSkyCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "sky-call" }>,
  ) {
    const active = this.active;
    if (
      !active ||
      message.evaluationId !== active.id ||
      !SKY_METHODS.has(message.method) ||
      !Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postSkyError(
        message.callId,
        new Error("Invalid sky protocol request."),
      );
      return;
    }

    try {
      const method = this.sky[message.method] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const value = await method(...message.args);
      if (serializedSize(value) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
        throw new Error("sky result exceeds the protocol limit.");
      }
      if (!this.closed && this.active === active) {
        this.post({
          type: "sky-result",
          callId: message.callId,
          ok: true,
          value,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postSkyError(message.callId, error);
      }
    }
  }

  private postSkyError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "sky-result",
        callId,
        ok: false,
        error: serializeError(error),
      });
    } catch (postError) {
      this.handleWorkerFailure(
        postError instanceof Error ? postError : new Error(String(postError)),
      );
    }
  }

  private terminateActive(error: KernelTerminatedError) {
    const active = this.active;
    if (!active) return;
    active.controller.abort(error);
    this.settleActive(active, error);
    this.close();
  }

  private settleActive(
    active: ActiveEvaluation,
    error: Error | null,
    output = "",
  ) {
    if (this.active !== active) return;
    this.active = null;
    clearTimeout(active.timeout);
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener("abort", active.onAbort);
    }
    if (!active.controller.signal.aborted) {
      active.controller.abort(
        error ?? new Error("Node REPL evaluation completed."),
      );
    }
    if (error) active.reject(error);
    else active.resolve(output);
  }

  private handleWorkerFailure(error: Error) {
    if (this.closed) return;
    const terminated = new KernelTerminatedError(
      `Node REPL worker failed: ${error.message}`,
    );
    const active = this.active;
    if (active) {
      active.controller.abort(terminated);
      this.settleActive(active, terminated);
    }
    this.close();
    this.onTerminated(this);
  }
}

export class NodeReplKernelRegistry {
  private readonly kernels = new Map<string, NodeReplKernel>();
  private readonly disposedKernels = new WeakSet<NodeReplKernel>();
  private readonly runner: ComputerCommandRunner;
  private readonly evalTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: NodeReplKernelManagerOptions = {}) {
    this.runner =
      options.runner ?? createInProcessComputerCommandRunner(options.executor);
    this.evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async evaluate(
    code: string,
    context: ToolContext,
    options: EvaluateOptions = {},
  ): Promise<string> {
    const id = getStellaComputerSessionId(context);
    if (!id) {
      throw new Error(
        "node_repl requires a stable Stella agent/session identity.",
      );
    }
    let kernel = this.kernels.get(id);
    if (!kernel) {
      const cwd = path.resolve(
        context.toolWorkspaceRoot ?? context.stellaAppDir ?? process.cwd(),
      );
      kernel = new NodeReplKernel(id, cwd, {
        cliPath: this.options.cliPath,
        runner: this.runner,
        evalTimeoutMs: this.evalTimeoutMs,
        commandTimeoutMs: this.commandTimeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        onIdle: (candidate) => this.disposeKernel(id, candidate),
      });
      this.kernels.set(id, kernel);
    }

    try {
      return await kernel.enqueue(
        code,
        options,
        {
          evalTimeoutMs: this.evalTimeoutMs,
          idleTimeoutMs: this.idleTimeoutMs,
        },
        (candidate) => this.disposeKernel(id, candidate),
      );
    } catch (error) {
      if (error instanceof KernelTerminatedError) {
        this.disposeKernel(id, kernel);
      }
      throw error;
    }
  }

  dispose() {
    for (const [id, kernel] of [...this.kernels]) {
      this.disposeKernel(id, kernel);
    }
  }

  private disposeKernel(id: string, kernel: NodeReplKernel) {
    kernel.close();
    if (!this.disposedKernels.has(kernel)) {
      this.disposedKernels.add(kernel);
      try {
        void Promise.resolve(this.options.disposeSession?.(id)).catch(
          () => undefined,
        );
      } catch {
        // Session cleanup must not mask the evaluation or shutdown outcome.
      }
    }
    if (this.kernels.get(id) === kernel) this.kernels.delete(id);
  }
}

export { NodeReplKernelRegistry as NodeReplKernelManager };
