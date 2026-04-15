import { fork } from "child_process";
import { fileURLToPath } from "node:url";
import {
  EXECUTE_TYPESCRIPT_TOOL_NAME,
} from "./execute-typescript-contract.js";
import {
  resolveFilePath,
} from "./file.js";
import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolResult,
} from "./types.js";
import {
  truncate,
} from "./utils.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_LOGS = 200;
const MAX_CALLS = 400;
const EXECUTE_TYPESCRIPT_RUNNER_PATH = fileURLToPath(
  new URL("./execute-typescript-runner.js", import.meta.url),
);

type ExecutionPhase = "compile" | "execute" | "binding" | "library";

type ExecuteTypescriptLogEntry = {
  level: "log" | "info" | "warn" | "error";
  message: string;
  timestamp: number;
};

type ExecuteTypescriptCallEntry = {
  binding: string;
  method: string;
  durationMs: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
};

type ExecuteTypescriptLibraryEntry = {
  name: string;
  durationMs: number;
  inputPreview?: string;
  resultPreview?: string;
  error?: string;
};

type ExecuteTypescriptDetails = {
  tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
  summary: string;
  success: boolean;
  value?: unknown;
  logs: ExecuteTypescriptLogEntry[];
  calls: ExecuteTypescriptCallEntry[];
  libraries: ExecuteTypescriptLibraryEntry[];
  error?: {
    message: string;
    phase: ExecutionPhase;
  };
};

type ShellExecOptions = {
  description?: string;
  workingDirectory?: string;
  timeoutMs?: number;
};

type ExecuteTypescriptUpdate =
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "execution_started";
      statusText: string;
      summary?: string;
    }
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "binding_call" | "binding_result" | "binding_error";
      statusText: string;
      binding: string;
      method: string;
      durationMs?: number;
      argsPreview?: string;
      resultPreview?: string;
      error?: string;
    }
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "console";
      statusText: string;
      level: ExecuteTypescriptLogEntry["level"];
      message: string;
    }
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "library_start" | "library_end";
      statusText: string;
      library: string;
      durationMs?: number;
      resultPreview?: string;
      error?: string;
    };

type ExecuteCapabilityTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
  extras?: ToolHandlerExtras,
) => Promise<ToolResult>;

type ExecuteTypescriptHandlerOptions = {
  stellaRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  stellaBrowserBridgeEnv?: Record<string, string>;
  executeCapabilityTool: ExecuteCapabilityTool;
};

type ExecutionTimer = {
  deadlineAt: number;
  getRemainingMs: () => number;
  assertAlive: (phase: ExecutionPhase) => void;
};

type ExecutionState = {
  logs: ExecuteTypescriptLogEntry[];
  calls: ExecuteTypescriptCallEntry[];
  libraries: ExecuteTypescriptLibraryEntry[];
};

type ExecutionEnvironment = {
  options: ExecuteTypescriptHandlerOptions;
  context: ToolContext;
  extras?: ToolHandlerExtras;
  timer: ExecutionTimer;
  state: ExecutionState;
};

class ExecuteTypescriptError extends Error {
  readonly phase: ExecutionPhase;

  constructor(message: string, phase: ExecutionPhase) {
    super(message);
    this.name = "ExecuteTypescriptError";
    this.phase = phase;
  }
}

const previewUnknown = (value: unknown, max = 240): string => {
  if (typeof value === "string") {
    return truncate(value, max).trim();
  }
  try {
    return truncate(JSON.stringify(value), max).trim();
  } catch {
    return truncate(String(value), max).trim();
  }
};

const ensureJsonSerializable = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new ExecuteTypescriptError(
      `Return value must be JSON-serializable: ${(error as Error).message}`,
      "execute",
    );
  }
};

const withPhase = (error: unknown, phase: ExecutionPhase): ExecuteTypescriptError =>
  error instanceof ExecuteTypescriptError
    ? error
    : new ExecuteTypescriptError(
        error instanceof Error ? error.message : String(error),
        phase,
      );

const createExecutionTimer = (
  timeoutMs: number,
  signal?: AbortSignal,
): ExecutionTimer => {
  const deadlineAt = Date.now() + timeoutMs;

  const assertAlive = (phase: ExecutionPhase) => {
    if (signal?.aborted) {
      throw new ExecuteTypescriptError("Execution aborted", phase);
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ExecuteTypescriptError("Execution timed out", phase);
    }
  };

  return {
    deadlineAt,
    getRemainingMs: () => Math.max(1, deadlineAt - Date.now()),
    assertAlive,
  };
};

const emitUpdate = (
  extras: ToolHandlerExtras | undefined,
  result: string,
  details: ExecuteTypescriptUpdate,
): void => {
  extras?.onUpdate?.({ result, details });
};

const pushCall = (
  state: ExecutionState,
  entry: ExecuteTypescriptCallEntry,
): void => {
  if (state.calls.length >= MAX_CALLS) {
    return;
  }
  state.calls.push(entry);
};

const createBindingCall = async <T>(
  env: ExecutionEnvironment,
  binding: string,
  method: string,
  argsValue: unknown,
  action: () => Promise<T>,
): Promise<T> => {
  env.timer.assertAlive("binding");
  const argsPreview = previewUnknown(argsValue);
  emitUpdate(env.extras, `Code mode · ${binding}.${method}`, {
    tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
    kind: "binding_call",
    statusText: `Code mode · ${binding}.${method}`,
    binding,
    method,
    argsPreview,
  });

  const startedAt = Date.now();
  try {
    const value = await action();
    env.timer.assertAlive("binding");
    const durationMs = Date.now() - startedAt;
    const resultPreview = previewUnknown(value);
    pushCall(env.state, {
      binding,
      method,
      durationMs,
      argsPreview,
      resultPreview,
    });
    emitUpdate(env.extras, `Code mode · ${binding}.${method} finished`, {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "binding_result",
      statusText: `Code mode · ${binding}.${method} finished`,
      binding,
      method,
      durationMs,
      argsPreview,
      resultPreview,
    });
    return value;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    pushCall(env.state, {
      binding,
      method,
      durationMs,
      argsPreview,
      error: errorMessage,
    });
    emitUpdate(env.extras, `Code mode · ${binding}.${method} failed`, {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "binding_error",
      statusText: `Code mode · ${binding}.${method} failed`,
      binding,
      method,
      durationMs,
      argsPreview,
      error: errorMessage,
    });
    throw withPhase(error, binding === "libraries" ? "library" : "binding");
  }
};

const createShellExecutor = (env: ExecutionEnvironment) => {
  return async (
    command: string,
    options?: ShellExecOptions,
  ): Promise<string> =>
    await createBindingCall(
      env,
      "shell",
      "exec",
      {
        command:
          typeof command === "string" ? command : previewUnknown(command, 1_000),
        options: options ?? null,
      },
      async () => {
        if (typeof command !== "string") {
          if (
            command !== null &&
            typeof command === "object" &&
            "command" in command
          ) {
            throw new ExecuteTypescriptError(
              "shell.exec now expects shell.exec(command, options?) with the command as the first argument.",
              "binding",
            );
          }
          throw new ExecuteTypescriptError(
            "shell.exec expects shell.exec(command, options?) with command as a string.",
            "binding",
          );
        }
        if (command.trim().length === 0) {
          throw new ExecuteTypescriptError(
            "shell.exec requires a non-empty command string.",
            "binding",
          );
        }
        if (
          options !== undefined &&
          (options === null || typeof options !== "object" || Array.isArray(options))
        ) {
          throw new ExecuteTypescriptError(
            "shell.exec options must be an object when provided.",
            "binding",
          );
        }
        if (options && "timeout" in options) {
          throw new ExecuteTypescriptError(
            "shell.exec uses timeoutMs in its second argument, not timeout.",
            "binding",
          );
        }

        const workingDirectory = options?.workingDirectory
          ? resolveFilePath(options.workingDirectory, env.context)
          : env.context.stellaRoot ?? env.options.stellaRoot ?? process.cwd();
        const result = await env.options.executeCapabilityTool(
          "Bash",
          {
            command,
            ...(options?.description ? { description: options.description } : {}),
            working_directory: workingDirectory,
            timeout: Math.min(
              typeof options?.timeoutMs === "number"
                ? options.timeoutMs
                : env.timer.getRemainingMs(),
              env.timer.getRemainingMs(),
            ),
          },
          env.context,
          { signal: env.extras?.signal },
        );
        if (result.error) {
          throw new Error(result.error);
        }
        return typeof result.result === "string"
          ? result.result
          : previewUnknown(result.result, 8_000);
      },
    );
};

const applyExecutionState = (
  target: ExecutionState,
  incoming: unknown,
): void => {
  if (!incoming || typeof incoming !== "object") {
    return;
  }
  const state = incoming as Partial<ExecutionState>;
  if (Array.isArray(state.logs)) {
    target.logs.splice(
      0,
      target.logs.length,
      ...state.logs.slice(0, MAX_LOGS) as ExecuteTypescriptLogEntry[],
    );
  }
  if (Array.isArray(state.calls)) {
    target.calls.splice(
      0,
      target.calls.length,
      ...state.calls.slice(0, MAX_CALLS) as ExecuteTypescriptCallEntry[],
    );
  }
  if (Array.isArray(state.libraries)) {
    target.libraries.splice(
      0,
      target.libraries.length,
      ...state.libraries as ExecuteTypescriptLibraryEntry[],
    );
  }
};

const executeProgram = async (args: {
  env: ExecutionEnvironment;
  code: string;
  sourceLabel: string;
  input?: unknown;
}): Promise<unknown> => {
  args.env.timer.assertAlive("compile");

  const workspaceRoot =
    args.env.context.stellaRoot ?? args.env.options.stellaRoot ?? process.cwd();

  return await new Promise<unknown>((resolve, reject) => {
    const child = fork(EXECUTE_TYPESCRIPT_RUNNER_PATH, [], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let finished = false;
    let stdout = "";
    let stderr = "";
    let timeoutId: NodeJS.Timeout | undefined;

    const settle = (callback: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      args.env.extras?.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const rejectWith = (error: unknown, phase: ExecutionPhase = "execute") => {
      settle(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore failures if the child already exited.
        }
        reject(withPhase(error, phase));
      });
    };

    const onAbort = () => {
      rejectWith(new ExecuteTypescriptError("Execution aborted", "execute"));
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    timeoutId = setTimeout(() => {
      rejectWith(new ExecuteTypescriptError("Execution timed out", "execute"));
    }, args.env.timer.getRemainingMs());

    args.env.extras?.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const payload = message as {
        type?: string;
        result?: string;
        details?: ExecuteTypescriptUpdate;
        value?: unknown;
        state?: unknown;
        message?: string;
        phase?: ExecutionPhase;
      };
      if (payload.type === "update" && payload.details) {
        emitUpdate(args.env.extras, String(payload.result ?? ""), payload.details);
        return;
      }
      if (payload.type === "result") {
        applyExecutionState(args.env.state, payload.state);
        settle(() => resolve(payload.value));
        return;
      }
      if (payload.type === "error") {
        applyExecutionState(args.env.state, payload.state);
        rejectWith(
          new ExecuteTypescriptError(
            String(payload.message ?? "Execution failed"),
            payload.phase ?? "execute",
          ),
        );
      }
    });

    child.on("error", (error) => {
      rejectWith(error, "execute");
    });

    child.on("exit", (code, signal) => {
      if (finished) {
        return;
      }
      const trailer = `${stdout}${stderr}`.trim();
      rejectWith(
        new ExecuteTypescriptError(
          trailer ||
            `Execution runner exited unexpectedly with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`,
          "execute",
        ),
      );
    });

    child.send({
      code: args.code,
      sourceLabel: args.sourceLabel,
      input: args.input,
      timeoutMs: Math.min(args.env.timer.getRemainingMs(), MAX_TIMEOUT_MS),
      stellaRoot: args.env.options.stellaRoot,
      stellaBrowserBinPath: args.env.options.stellaBrowserBinPath,
      stellaOfficeBinPath: args.env.options.stellaOfficeBinPath,
      stellaUiCliPath: args.env.options.stellaUiCliPath,
      stellaBrowserBridgeEnv: args.env.options.stellaBrowserBridgeEnv,
      browserOwnerId:
        args.env.context.taskId ?? args.env.context.runId ?? args.env.context.rootRunId,
    });
  });
};

export const createExecuteTypescriptToolHandlers = (
  options: ExecuteTypescriptHandlerOptions,
): Record<string, ToolHandler> => ({
  [EXECUTE_TYPESCRIPT_TOOL_NAME]: async (
    rawArgs,
    context,
    extras,
  ): Promise<ToolResult> => {
    const summary = String(rawArgs.summary ?? "").trim();
    const code = String(rawArgs.code ?? "");
    const requestedTimeout = Number(rawArgs.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.max(
      1_000,
      Math.min(
        Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
    );

    if (!summary) {
      return { error: "summary is required." };
    }
    if (!code.trim()) {
      return { error: "code is required." };
    }

    const timer = createExecutionTimer(timeoutMs, extras?.signal);
    const state: ExecutionState = {
      logs: [],
      calls: [],
      libraries: [],
    };

    emitUpdate(extras, "Code mode · compiling program", {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "execution_started",
      statusText: "Code mode · compiling program",
      summary,
    });

    try {
      const value = await executeProgram({
        env: {
          options,
          context,
          extras,
          timer,
          state,
        },
        code,
        sourceLabel: EXECUTE_TYPESCRIPT_TOOL_NAME,
      });
      const serializedValue = ensureJsonSerializable(value);
      const details: ExecuteTypescriptDetails = {
        tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
        summary,
        success: true,
        ...(serializedValue !== undefined ? { value: serializedValue } : {}),
        logs: state.logs,
        calls: state.calls,
        libraries: state.libraries,
      };
      return {
        result: serializedValue === undefined ? "Program completed." : serializedValue,
        details,
      };
    } catch (error) {
      const typedError = withPhase(error, "execute");
      const details: ExecuteTypescriptDetails = {
        tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
        summary,
        success: false,
        logs: state.logs,
        calls: state.calls,
        libraries: state.libraries,
        error: {
          message: typedError.message,
          phase: typedError.phase,
        },
      };
      return {
        error: `${EXECUTE_TYPESCRIPT_TOOL_NAME} failed during ${typedError.phase}: ${typedError.message}`,
        details,
      };
    }
  },
});
