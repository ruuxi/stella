import { spawn } from "node:child_process";

import {
  executeStellaComputerCommand,
  type StellaComputerExecutionOptions,
  type StellaComputerExecutionResult,
} from "./stella-computer-executor.js";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ComputerCommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
};

export type ComputerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ComputerCommandRunner = (
  request: ComputerCommandRequest,
) => Promise<ComputerCommandResult>;

export type StellaComputerExecutor = (
  argv: string[],
  options?: StellaComputerExecutionOptions,
) => Promise<StellaComputerExecutionResult>;

export const createInProcessComputerCommandRunner =
  (
    executor: StellaComputerExecutor = executeStellaComputerCommand,
  ): ComputerCommandRunner =>
  async (request) => {
    if (request.signal?.aborted) {
      throw request.signal.reason instanceof Error
        ? request.signal.reason
        : new Error("Computer command aborted.");
    }
    if (request.command !== process.execPath) {
      throw new Error(
        `In-process computer runner only accepts process.execPath requests, received ${request.command}.`,
      );
    }
    if (request.args.length === 0) {
      throw new Error(
        "In-process computer runner requires a CLI adapter path.",
      );
    }
    return await executor(request.args.slice(1), {
      cwd: request.cwd,
      cliPath: request.args[0],
      env: request.env,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    });
  };

export const runComputerCommandInProcess =
  createInProcessComputerCommandRunner();

// Explicit subprocess path retained for CLI diagnostics and process-boundary tests.
export const runComputerCommandSubprocess: ComputerCommandRunner = async (
  request,
) => {
  if (request.signal?.aborted) {
    throw request.signal.reason instanceof Error
      ? request.signal.reason
      : new Error("Computer command aborted.");
  }

  return await new Promise<ComputerCommandResult>((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (callback: () => void, options: { kill?: boolean } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      if (options.kill && child.exitCode === null) child.kill();
      callback();
    };
    const onAbort = () =>
      finish(
        () =>
          reject(
            request.signal?.reason instanceof Error
              ? request.signal.reason
              : new Error("Computer command aborted."),
          ),
        { kill: true },
      );
    const timeout = setTimeout(
      () =>
        finish(
          () =>
            reject(
              new Error(
                `Computer command timed out after ${request.timeoutMs}ms.`,
              ),
            ),
          { kill: true },
        ),
      request.timeoutMs,
    );

    request.signal?.addEventListener("abort", onAbort, { once: true });
    const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      if (outputBytes > maxOutputBytes) {
        finish(
          () =>
            reject(
              new Error(
                `Computer command output exceeded the ${maxOutputBytes}-byte limit.`,
              ),
            ),
          { kill: true },
        );
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      appendOutput("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      appendOutput("stderr", chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) =>
      finish(() => resolve({ exitCode: exitCode ?? 1, stdout, stderr })),
    );
  });
};
