import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { Worker } from "node:worker_threads";

import type {
  ToolContext,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import { getStellaComputerSessionId } from "../tools/stella-computer-session.js";
import {
  maybeRequestBrowserExtensionConnect,
  type BrowserExtensionConnectRequester,
} from "../tools/browser-extension-offer.js";
import {
  createBrowserSession,
  type BrowserChainOptions,
  type BrowserChainStep,
  type BrowserCommandParams,
  type BrowserProtocolAction,
  type BrowserSessionClient,
  type BrowserSessionOptions,
} from "../browser-use/client.js";
import {
  createSkyClient,
  type AuthorizeApp,
  type SkyClient,
} from "./client.js";
import { createNodeReplWorkerSource } from "./kernel-worker.js";
import type { ComputerUseSession } from "./session.js";
import {
  MAX_NODE_REPL_CODE_BYTES,
  MAX_NODE_REPL_OUTPUT_BYTES,
  MAX_NODE_REPL_PENDING_BROWSER_CALLS,
  MAX_NODE_REPL_PENDING_SKY_CALLS,
  MAX_NODE_REPL_PENDING_TOOL_CALLS,
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
  browserBinPath?: string;
  sessionFactory?: ComputerUseSessionFactory;
  authorizeApp?: AuthorizeApp;
  browserSessionFactory?: (
    options: BrowserSessionOptions,
  ) => BrowserSessionClient;
  requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
  disposeSession?: (sessionId: string) => void | Promise<void>;
  evalTimeoutMs?: number;
  commandTimeoutMs?: number;
  idleTimeoutMs?: number;
  executeTool?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
};

export type ComputerUseSessionFactoryOptions = Readonly<{
  sessionId: string;
  cwd: string;
  getSignal: () => AbortSignal | undefined;
  timeoutMs: number;
}>;

export type ComputerUseSessionFactory = (
  options: ComputerUseSessionFactoryOptions,
) => ComputerUseSession;

export type EvaluateOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onToolResult?: (result: ToolResult) => void;
  onToolUpdate?: ToolUpdateCallback;
};

class KernelTerminatedError extends Error {}

/**
 * Error name the worker assigns to uncaught async throws surfaced through the
 * REPL's output stream (see the inline literal in `kernel-worker.ts`, which is
 * serialized into the worker source and cannot share this constant).
 */
const NODE_REPL_UNCAUGHT_ERROR_NAME = "NodeReplUncaughtError";

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
  context: ToolContext;
  onToolResult?: (result: ToolResult) => void;
  onToolUpdate?: ToolUpdateCallback;
  browserActivity: {
    callCount: number;
    mutated: boolean;
    visualMutated: boolean;
    screenshotObserved: boolean;
    terminalLifecycle: boolean;
    lastAction?: string;
  };
};

const BROWSER_METHODS = new Set(["command", "chain"]);
const READ_ONLY_BROWSER_ACTIONS = new Set([
  "healthcheck",
  "url",
  "title",
  "screenshot",
  "snapshot",
  "content",
  "gettext",
  "getattribute",
  "innertext",
  "innerhtml",
  "inputvalue",
  "boundingbox",
  "isvisible",
  "isenabled",
  "ischecked",
  "count",
  "styles",
  "requests",
  "responsebody",
  "cookies_get",
  "site_mod_list",
  "tab_list",
  "wait",
  "waitforurl",
]);
const NON_VISUAL_BROWSER_MUTATIONS = new Set([
  "cookies_set",
  "cookies_clear",
  "site_mod_set",
  "site_mod_remove",
  "site_mod_toggle",
  "route",
  "unroute",
  "har_start",
  "har_stop",
  "clipboard",
  "finalize_tabs",
  "close_owner",
]);
const MAX_BROWSER_SCREENSHOT_FILES_PER_KERNEL = 100;
const NODE_REPL_EXCLUDED_TOOL_NAMES = new Set([
  "node_repl",
  "multi_tool_use_parallel",
]);

type NodeReplTransport = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  postMessage(message: ParentToNodeReplWorkerMessage): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<unknown>;
};

export const isBunNodeReplRuntime = (
  versions: NodeJS.ProcessVersions & { bun?: string } = process.versions,
) => Boolean(versions.bun);

const createNodeReplTransport = (
  source: string,
  workerData: NodeReplWorkerData,
  name: string,
): NodeReplTransport => {
  if (!isBunNodeReplRuntime()) {
    return new Worker(source, { eval: true, workerData, name });
  }

  const executable =
    process.env.STELLA_NODE_BIN?.trim() ||
    process.env.STELLA_HOST_EXECUTABLE_PATH?.trim() ||
    "node";
  const child = spawn(executable, ["-"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      STELLA_NODE_REPL_WORKER_DATA: JSON.stringify(workerData),
    },
    stdio: ["pipe", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.stdin?.end(source);

  return {
    on(event, listener) {
      child.on(event, listener as never);
      return child;
    },
    postMessage(message) {
      if (!child.connected) {
        throw new Error("Node REPL child transport is not connected.");
      }
      child.send(message);
    },
    ref() {
      child.ref();
      child.channel?.ref?.();
    },
    unref() {
      child.unref();
      child.channel?.unref?.();
    },
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
};

class NodeReplKernel {
  private readonly worker: NodeReplTransport;
  private readonly sky: SkyClient;
  private readonly browser: BrowserSessionClient;
  private readonly requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
  private readonly executeTool?: NodeReplKernelManagerOptions["executeTool"];
  private readonly onTerminated: (kernel: NodeReplKernel) => void;
  private tail: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private pending = 0;
  private skyTail: Promise<void> = Promise.resolve();
  private browserTail: Promise<void> = Promise.resolve();
  private nextEvaluationId = 1;
  private active: ActiveEvaluation | null = null;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly browserScreenshotPaths = new Set<string>();

  constructor(
    readonly id: string,
    cwd: string,
    options: Required<
      Pick<
        NodeReplKernelManagerOptions,
        | "sessionFactory"
        | "evalTimeoutMs"
        | "commandTimeoutMs"
        | "idleTimeoutMs"
      >
    > & {
      authorizeApp?: AuthorizeApp;
      browserBinPath?: string;
      browserSessionFactory: (
        options: BrowserSessionOptions,
      ) => BrowserSessionClient;
      requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
      executeTool?: NodeReplKernelManagerOptions["executeTool"];
      toolNames: string[];
      onIdle: (kernel: NodeReplKernel) => void;
    },
  ) {
    this.onTerminated = options.onIdle;
    this.requestBrowserExtensionConnect =
      options.requestBrowserExtensionConnect;
    this.executeTool = options.executeTool;
    const getSignal = () => this.active?.controller.signal;
    const session = options.sessionFactory({
      sessionId: id,
      cwd,
      getSignal,
      timeoutMs: options.commandTimeoutMs,
    });
    this.sky = createSkyClient({
      sessionId: id,
      session,
      getSignal,
      authorizeApp: options.authorizeApp,
    });
    this.browser = options.browserSessionFactory({
      ...(options.browserBinPath ? { binaryPath: options.browserBinPath } : {}),
      sessionId: id,
      cwd,
      commandTimeoutMs: options.commandTimeoutMs,
      disposeCleanup: { action: "close_owner" },
    });
    const workerData: NodeReplWorkerData = {
      cwd,
      moduleUrl: import.meta.url,
      maxCodeBytes: MAX_NODE_REPL_CODE_BYTES,
      maxEvalOutputBytes: MAX_NODE_REPL_OUTPUT_BYTES,
      maxProtocolMessageBytes: MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES,
      maxPendingSkyCalls: MAX_NODE_REPL_PENDING_SKY_CALLS,
      maxPendingBrowserCalls: MAX_NODE_REPL_PENDING_BROWSER_CALLS,
      maxPendingToolCalls: MAX_NODE_REPL_PENDING_TOOL_CALLS,
      toolNames: options.toolNames,
    };
    this.worker = createNodeReplTransport(
      createNodeReplWorkerSource(),
      workerData,
      `stella-node-repl-${id.slice(0, 48)}`,
    );
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
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
    this.closePromise = Promise.allSettled([
      this.worker.terminate(),
      this.browser.dispose(),
      this.cleanupBrowserScreenshots(),
    ]).then(() => undefined);
    return this.closePromise;
  }

  enqueue(
    code: string,
    context: ToolContext,
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
        context,
        options.timeoutMs ?? defaults.evalTimeoutMs,
        options.signal,
        options.onToolResult,
        options.onToolUpdate,
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
    context: ToolContext,
    timeoutMs: number,
    signal?: AbortSignal,
    onToolResult?: (result: ToolResult) => void,
    onToolUpdate?: ToolUpdateCallback,
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
        context,
        onToolResult,
        onToolUpdate,
        browserActivity: {
          callCount: 0,
          mutated: false,
          visualMutated: false,
          screenshotObserved: false,
          terminalLifecycle: false,
        },
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
    if (typed.type === "browser-call") {
      const run = () => this.handleBrowserCall(typed);
      const task = this.browserTail.then(run, run);
      this.browserTail = task.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    if (typed.type === "tool-call") {
      void this.handleToolCall(typed);
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
      void this.completeEvaluation(active, typed.output);
      return;
    }
    if (typed.type === "evaluation-error") {
      const error = deserializeError(typed.error);
      if (error.name === NODE_REPL_UNCAUGHT_ERROR_NAME) {
        // The worker's REPL caught an uncaught async throw via its domain and
        // abandoned the in-flight evaluation; the REPL cannot be safely
        // reused. Terminate so the registry disposes this kernel's session
        // and the next evaluate starts a fresh kernel.
        this.terminateActive(new KernelTerminatedError(error.message));
        return;
      }
      this.settleActive(active, error);
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

  private async handleBrowserCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
  ) {
    const active = this.active;
    if (
      !active ||
      message.evaluationId !== active.id ||
      !BROWSER_METHODS.has(message.method) ||
      !Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postBrowserError(
        message.callId,
        new Error("Invalid browser protocol request."),
      );
      return;
    }

    try {
      let value: unknown;
      try {
        value = await this.executeBrowserMessage(active, message);
      } catch (error) {
        const outcome = await maybeRequestBrowserExtensionConnect({
          output: error instanceof Error ? error.message : String(error),
          command: "stella-browser node_repl",
          requestConnect: this.requestBrowserExtensionConnect,
          conversationId: active.context.conversationId,
          agentId: active.context.agentId,
          signal: active.controller.signal,
        });
        if (!outcome?.ok) throw error;
        value = await this.executeBrowserMessage(active, message);
      }
      if (serializedSize(value) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
        throw new Error("browser result exceeds the protocol limit.");
      }
      this.recordBrowserActivity(active, message);
      if (!this.closed && this.active === active) {
        this.post({
          type: "browser-result",
          callId: message.callId,
          ok: true,
          value,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postBrowserError(message.callId, error);
      }
    }
  }

  private async executeBrowserMessage(
    active: ActiveEvaluation,
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
  ): Promise<unknown> {
    if (message.method === "command") {
      if (message.args.length < 1 || message.args.length > 2) {
        throw new Error("Invalid browser command arguments.");
      }
      return await this.browser.command(
        message.args[0] as BrowserProtocolAction,
        message.args[1] as BrowserCommandParams | undefined,
        { signal: active.controller.signal },
      );
    }
    if (message.args.length < 1 || message.args.length > 2) {
      throw new Error("Invalid browser chain arguments.");
    }
    const wireOptions =
      message.args[1] && typeof message.args[1] === "object"
        ? (message.args[1] as Record<string, unknown>)
        : {};
    const wireDelay =
      wireOptions.delay && typeof wireOptions.delay === "object"
        ? (wireOptions.delay as Record<string, unknown>)
        : undefined;
    const chainOptions: BrowserChainOptions = {
      signal: active.controller.signal,
      ...(wireOptions.abortOnError === undefined
        ? {}
        : { abortOnError: wireOptions.abortOnError as boolean }),
      ...(wireDelay
        ? {
            delay: {
              minMs: wireDelay.min as number | undefined,
              maxMs: wireDelay.max as number | undefined,
            },
          }
        : {}),
      ...(wireOptions.waitForSelector === undefined
        ? {}
        : { waitForSelector: wireOptions.waitForSelector as boolean }),
      ...(wireOptions.waitTimeout === undefined
        ? {}
        : { waitTimeoutMs: wireOptions.waitTimeout as number }),
      ...(wireOptions.returnSnapshot === undefined
        ? {}
        : { returnSnapshot: wireOptions.returnSnapshot as boolean }),
      ...(wireOptions.returnScreenshot === undefined
        ? {}
        : { returnScreenshot: wireOptions.returnScreenshot as boolean }),
    };
    return await this.browser.chain(
      message.args[0] as readonly BrowserChainStep[],
      chainOptions,
    );
  }

  private postBrowserError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "browser-result",
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

  private async handleToolCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "tool-call" }>,
  ) {
    const active = this.active;
    const allowedToolNames = new Set(active?.context.allowedToolNames ?? []);
    if (
      !active ||
      message.evaluationId !== active.id ||
      !this.executeTool ||
      NODE_REPL_EXCLUDED_TOOL_NAMES.has(message.toolName) ||
      !allowedToolNames.has(message.toolName) ||
      !message.args ||
      typeof message.args !== "object" ||
      Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postToolError(
        message.callId,
        new Error("Invalid or unauthorized tool protocol request."),
      );
      return;
    }

    try {
      const result = await this.executeTool(
        message.toolName,
        message.args,
        active.context,
        active.controller.signal,
        (update) => {
          if (!this.closed && this.active === active) {
            active.onToolUpdate?.(update);
          }
        },
      );
      if (!this.closed && this.active === active) {
        active.onToolResult?.(result);
      }
      if (result.error) throw new Error(result.error);
      if (serializedSize(result.result) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
        throw new Error("Tool result exceeds the Node REPL protocol limit.");
      }
      if (!this.closed && this.active === active) {
        this.post({
          type: "tool-result",
          callId: message.callId,
          ok: true,
          value: result.result,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postToolError(message.callId, error);
      }
    }
  }

  private postToolError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "tool-result",
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

  private recordBrowserActivity(
    active: ActiveEvaluation,
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
  ) {
    const actions: string[] = [];
    if (message.method === "command") {
      if (typeof message.args[0] === "string") actions.push(message.args[0]);
    } else if (Array.isArray(message.args[0])) {
      for (const step of message.args[0]) {
        if (
          step &&
          typeof step === "object" &&
          typeof (step as { action?: unknown }).action === "string"
        ) {
          actions.push((step as { action: string }).action);
        }
      }
    }
    active.browserActivity.callCount += 1;
    for (const action of actions) {
      active.browserActivity.lastAction = action;
      if (action === "screenshot") {
        active.browserActivity.screenshotObserved = true;
      }
      if (action === "finalize_tabs" || action === "close_owner") {
        active.browserActivity.terminalLifecycle = true;
      }
      if (!READ_ONLY_BROWSER_ACTIONS.has(action)) {
        active.browserActivity.mutated = true;
        if (!NON_VISUAL_BROWSER_MUTATIONS.has(action)) {
          active.browserActivity.visualMutated = true;
        }
      }
    }
    if (
      message.method === "chain" &&
      message.args[1] &&
      typeof message.args[1] === "object" &&
      (message.args[1] as { returnScreenshot?: unknown }).returnScreenshot ===
        true
    ) {
      active.browserActivity.screenshotObserved = true;
    }
  }

  private async completeEvaluation(active: ActiveEvaluation, output: string) {
    if (this.active !== active) return;
    let finalOutput = output;
    const activity = active.browserActivity;
    if (activity.callCount > 0) {
      if (!activity.mutated || activity.terminalLifecycle) {
        const receipt = `[browser-receipt] calls=${activity.callCount} mutated=${activity.mutated}${
          activity.lastAction ? ` last=${activity.lastAction}` : ""
        }`;
        finalOutput = finalOutput ? `${finalOutput}\n${receipt}` : receipt;
        if (this.active === active) {
          this.settleActive(active, null, finalOutput);
        }
        return;
      }
      try {
        const tabsReceipt = await this.browser.command<Record<string, unknown>>(
          "tab_list",
          {},
          { signal: active.controller.signal },
        );
        const tabsData = tabsReceipt.result.data ?? {};
        const tabs = Array.isArray(tabsData.tabs) ? tabsData.tabs : [];
        const activeTabId =
          typeof tabsData.activeTabId === "number"
            ? tabsData.activeTabId
            : undefined;
        const receipt = `[browser-receipt] calls=${activity.callCount} mutated=${activity.mutated} tabs=${tabs.length}${
          activeTabId === undefined ? "" : ` activeTabId=${activeTabId}`
        }${activity.lastAction ? ` last=${activity.lastAction}` : ""}`;
        finalOutput = finalOutput ? `${finalOutput}\n${receipt}` : receipt;

        if (
          activity.visualMutated &&
          !activity.screenshotObserved &&
          activeTabId !== undefined
        ) {
          try {
            const screenshotReceipt = await this.browser.command<{
              base64?: string;
              format?: string;
            }>(
              "screenshot",
              { tabId: activeTabId, format: "jpeg", quality: 55 },
              { signal: active.controller.signal },
            );
            const screenshot = screenshotReceipt.result.data;
            if (typeof screenshot?.base64 === "string" && screenshot.base64) {
              const directory = path.join(os.tmpdir(), "stella-browser-repl");
              await mkdir(directory, { recursive: true });
              const screenshotPath = path.join(
                directory,
                `${randomUUID()}.jpeg`,
              );
              await writeFile(
                screenshotPath,
                Buffer.from(screenshot.base64, "base64"),
              );
              this.browserScreenshotPaths.add(screenshotPath);
              while (
                this.browserScreenshotPaths.size >
                MAX_BROWSER_SCREENSHOT_FILES_PER_KERNEL
              ) {
                const oldest = this.browserScreenshotPaths
                  .values()
                  .next().value;
                if (typeof oldest !== "string") break;
                this.browserScreenshotPaths.delete(oldest);
                await rm(oldest, { force: true }).catch(() => undefined);
              }
              finalOutput += `\n[stella-attach-image] inline=image/jpeg path=${JSON.stringify(screenshotPath)}`;
            }
          } catch {
            finalOutput += "\n[browser-visual] screenshot=unavailable";
          }
        }
      } catch {
        const receipt = `[browser-receipt] calls=${activity.callCount} mutated=${activity.mutated}${
          activity.lastAction ? ` last=${activity.lastAction}` : ""
        } settled_state=unavailable`;
        finalOutput = finalOutput ? `${finalOutput}\n${receipt}` : receipt;
      }
    }
    if (this.active === active) this.settleActive(active, null, finalOutput);
  }

  private async cleanupBrowserScreenshots(): Promise<void> {
    const paths = [...this.browserScreenshotPaths];
    this.browserScreenshotPaths.clear();
    await Promise.allSettled(
      paths.map((filePath) => rm(filePath, { force: true })),
    );
  }

  private terminateActive(error: KernelTerminatedError) {
    const active = this.active;
    if (!active) return;
    active.controller.abort(error);
    this.settleActive(active, error);
    void this.close();
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
    void this.close();
    this.onTerminated(this);
  }
}

export class NodeReplKernelRegistry {
  private readonly kernels = new Map<string, NodeReplKernel>();
  private readonly disposedKernels = new WeakSet<NodeReplKernel>();
  private readonly evalTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly browserSessionFactory: (
    options: BrowserSessionOptions,
  ) => BrowserSessionClient;

  constructor(private readonly options: NodeReplKernelManagerOptions = {}) {
    this.evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.browserSessionFactory =
      options.browserSessionFactory ?? createBrowserSession;
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
      const sessionFactory = this.options.sessionFactory;
      if (!sessionFactory) {
        throw new Error(
          "node_repl computer use requires a typed ComputerUseSession factory.",
        );
      }
      const cwd = path.resolve(
        context.toolWorkspaceRoot ?? context.stellaAppDir ?? process.cwd(),
      );
      kernel = new NodeReplKernel(id, cwd, {
        sessionFactory,
        authorizeApp: this.options.authorizeApp,
        browserBinPath: this.options.browserBinPath,
        browserSessionFactory: this.browserSessionFactory,
        requestBrowserExtensionConnect:
          this.options.requestBrowserExtensionConnect,
        executeTool: this.options.executeTool,
        toolNames: [...new Set(context.allowedToolNames ?? [])].filter(
          (name) => !NODE_REPL_EXCLUDED_TOOL_NAMES.has(name),
        ),
        evalTimeoutMs: this.evalTimeoutMs,
        commandTimeoutMs: this.commandTimeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        onIdle: (candidate) => void this.disposeKernel(id, candidate),
      });
      this.kernels.set(id, kernel);
    }

    try {
      return await kernel.enqueue(
        code,
        context,
        options,
        {
          evalTimeoutMs: this.evalTimeoutMs,
          idleTimeoutMs: this.idleTimeoutMs,
        },
        (candidate) => void this.disposeKernel(id, candidate),
      );
    } catch (error) {
      if (error instanceof KernelTerminatedError) {
        await this.disposeKernel(id, kernel);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [id, kernel] of [...this.kernels]) {
      pending.push(this.disposeKernel(id, kernel));
    }
    await Promise.all(pending);
  }

  private disposeKernel(id: string, kernel: NodeReplKernel): Promise<void> {
    const kernelClose = kernel.close();
    let sessionCleanup = Promise.resolve();
    if (!this.disposedKernels.has(kernel)) {
      this.disposedKernels.add(kernel);
      try {
        sessionCleanup = Promise.resolve(
          this.options.disposeSession?.(id),
        ).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        // Session cleanup must not mask the evaluation or shutdown outcome.
      }
    }
    if (this.kernels.get(id) === kernel) this.kernels.delete(id);
    return Promise.allSettled([kernelClose, sessionCleanup]).then(
      () => undefined,
    );
  }
}

export { NodeReplKernelRegistry as NodeReplKernelManager };
