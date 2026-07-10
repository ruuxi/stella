import { spawn } from "node:child_process";

export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type BrowserCommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type BrowserCommandProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BrowserCommandRunner = (
  request: BrowserCommandRequest,
) => Promise<BrowserCommandProcessResult>;

export type BrowserCommandRunnerErrorCode =
  | "aborted"
  | "output_limit"
  | "spawn_failed"
  | "timeout";

export class BrowserCommandRunnerError extends Error {
  readonly code: BrowserCommandRunnerErrorCode;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    code: BrowserCommandRunnerErrorCode,
    message: string,
    options: {
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BrowserCommandRunnerError";
    this.code = code;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
  }
}

const requirePositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
};

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new BrowserCommandRunnerError("aborted", "Browser command aborted.");

const diagnosticSuffix = (stdout: string, stderr: string): string => {
  const detail = stderr.trim() || stdout.trim();
  if (!detail) return "";
  const maxChars = 4_096;
  const bounded =
    detail.length <= maxChars
      ? detail
      : `${detail.slice(0, maxChars)}\n[diagnostic truncated]`;
  return `\n${bounded}`;
};

export const runBrowserCommand: BrowserCommandRunner = async (request) => {
  requirePositiveInteger(request.timeoutMs, "timeoutMs");
  requirePositiveInteger(request.maxOutputBytes, "maxOutputBytes");

  if (request.signal?.aborted) {
    throw abortReason(request.signal);
  }

  return await new Promise<BrowserCommandProcessResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      reject(
        new BrowserCommandRunnerError(
          "spawn_failed",
          `Failed to start stella-browser: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const capturedOutput = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });
    const finish = (callback: () => void, kill = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      if (kill && child.exitCode === null && !child.killed) {
        child.kill();
      }
      callback();
    };
    const onAbort = () =>
      finish(() => reject(abortReason(request.signal!)), true);
    const failWithOutput = (
      code: BrowserCommandRunnerErrorCode,
      message: string,
      cause?: unknown,
    ) => {
      const output = capturedOutput();
      finish(
        () =>
          reject(
            new BrowserCommandRunnerError(
              code,
              `${message}${diagnosticSuffix(output.stdout, output.stderr)}`,
              { ...output, cause },
            ),
          ),
        true,
      );
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      const remaining = request.maxOutputBytes - outputBytes;
      if (chunk.byteLength <= remaining) {
        target.push(chunk);
        outputBytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) {
        target.push(chunk.subarray(0, remaining));
      }
      outputBytes = request.maxOutputBytes;
      failWithOutput(
        "output_limit",
        `stella-browser output exceeded the ${request.maxOutputBytes}-byte limit.`,
      );
    };

    timeout = setTimeout(() => {
      failWithOutput(
        "timeout",
        `stella-browser timed out after ${request.timeoutMs}ms.`,
      );
    }, request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
    child.once("error", (cause) => {
      failWithOutput(
        "spawn_failed",
        `Failed to run stella-browser: ${cause.message}`,
        cause,
      );
    });
    child.once("close", (exitCode) => {
      const output = capturedOutput();
      finish(() =>
        resolve({
          exitCode: exitCode ?? 1,
          ...output,
        }),
      );
    });
  });
};
