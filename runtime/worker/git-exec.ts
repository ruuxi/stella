import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupGitEnvironment } from "../git-environment.js";

const execFileAsync = promisify(execFile);

export type GitRunStatus = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const toText = (value: string | Buffer | undefined): string =>
  Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");

export const runGitStatus = async (
  cwd: string,
  args: string[],
  options?: { maxBuffer?: number },
): Promise<GitRunStatus> => {
  const { env, gitLocation } = setupGitEnvironment();
  try {
    const result = await execFileAsync(gitLocation, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: options?.maxBuffer ?? 20 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout: toText(result.stdout),
      stderr: toText(result.stderr),
    };
  } catch (error) {
    const err = error as {
      code?: unknown;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: toText(err.stdout),
      stderr: toText(err.stderr),
    };
  }
};

export const runGit = async (
  cwd: string,
  args: string[],
  options?: { maxBuffer?: number },
): Promise<string> => {
  const result = await runGitStatus(cwd, args, options);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  const details =
    result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
};
