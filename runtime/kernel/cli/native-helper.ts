import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const platformDir =
  process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : process.platform;

const DEFAULT_TIMEOUT_MS = 15_000;

export const resolveNativeHelperPath = (baseName: string): string | null => {
  const ext = process.platform === "win32" ? ".exe" : "";
  const fileName = `${baseName}${ext}`;
  const candidates = [
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "native", "out", platformDir, fileName)
      : null,
    path.resolve(__dirname, "../../../desktop/native/out", platformDir, fileName),
    path.resolve(__dirname, "../../../../native/out", platformDir, fileName),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

type NativeHelperResult = {
  helperPath: string;
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
};

const readTrimmedFile = (filePath: string) => {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
};

const cleanupTempDir = (tempDir: string) => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
};

const killDetachedProcess = (pid: number | undefined) => {
  if (!pid) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGKILL");
      return;
    }
  } catch {
    // fall through to direct pid kill
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore kill failures
  }
};

export const runNativeHelper = async (args: {
  helperName: string;
  helperArgs: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<NativeHelperResult> => {
  const helperPath = resolveNativeHelperPath(args.helperName);
  if (!helperPath) {
    throw new Error(
      `Native helper "${args.helperName}" was not found. Build desktop/native first.`,
    );
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-native-helper-"));
  const stdoutPath = path.join(tempDir, "stdout.txt");
  const stderrPath = path.join(tempDir, "stderr.txt");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");

  try {
    const child = spawn(helperPath, args.helperArgs, {
      detached: process.platform !== "win32",
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: args.env,
    });
    child.unref();

    const completion = new Promise<NativeHelperResult>((resolve) => {
      child.once("error", (error) => {
        resolve({
          helperPath,
          status: 1,
          stdout: readTrimmedFile(stdoutPath),
          stderr: readTrimmedFile(stderrPath),
          error,
        });
      });

      child.once("exit", (code) => {
        resolve({
          helperPath,
          status: code ?? 1,
          stdout: readTrimmedFile(stdoutPath),
          stderr: readTrimmedFile(stderrPath),
        });
      });
    });

    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = new Promise<NativeHelperResult>((resolve) => {
      setTimeout(() => {
        killDetachedProcess(child.pid);
        const stdout = readTrimmedFile(stdoutPath);
        const stderr = readTrimmedFile(stderrPath);
        const message = stderr || `Native helper "${args.helperName}" timed out after ${timeoutMs}ms.`;
        resolve({
          helperPath,
          status: 1,
          stdout,
          stderr: message,
          timedOut: true,
        });
      }, timeoutMs);
    });

    const result = await Promise.race([completion, timeout]);
    if (!result.timedOut) {
      cleanupTempDir(tempDir);
    }
    return result;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
};
