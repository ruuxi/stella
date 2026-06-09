import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupEnvironment } from "dugite";

const execFileAsync = promisify(execFile);

export const normalizeGitPath = (value: string): string =>
  value.trim().replace(/\\/g, "/");

export type GitRunStatus = {
  exitCode: number;
  stdout: string | Buffer;
  stderr: string | Buffer;
};

export const toTrimmedString = (
  value: string | Buffer | undefined,
): string =>
  (Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "")).trim();

export const runGitStatus = async (
  repoRoot: string,
  args: string[],
  options?: {
    encoding?: "utf8" | "buffer";
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
  },
): Promise<GitRunStatus> => {
  const encoding = options?.encoding === "buffer" ? "buffer" : "utf8";
  const { env, gitLocation } = setupEnvironment(options?.env ?? {});
  try {
    const result = await execFileAsync(gitLocation, args, {
      cwd: repoRoot,
      env,
      encoding,
      maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: unknown;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
      stderr: err.stderr ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
    };
  }
};

export const runGit = async (
  repoRoot: string,
  args: string[],
  options?: {
    encoding?: "utf8" | "buffer";
    maxBuffer?: number;
  },
): Promise<string> => {
  const result = await runGitStatus(repoRoot, args, {
    encoding: options?.encoding,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
  });
  if (result.exitCode === 0) {
    return toTrimmedString(result.stdout);
  }

  const stderr = toTrimmedString(result.stderr);
  const stdout = toTrimmedString(result.stdout);
  const details = stderr || stdout || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
};

export const runGitWithEnv = async (
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const result = await runGitStatus(repoRoot, args, { env });
  if (result.exitCode === 0) {
    return toTrimmedString(result.stdout);
  }
  const stderr = toTrimmedString(result.stderr);
  const stdout = toTrimmedString(result.stdout);
  const details = stderr || stdout || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
};

export const runGitWithEnvStatus = async (
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const result = await runGitStatus(repoRoot, args, { env });
  return {
    exitCode: result.exitCode,
    stdout: toTrimmedString(result.stdout),
    stderr: toTrimmedString(result.stderr),
  };
};

export const assertGitRepository = async (repoRoot: string): Promise<void> => {
  const output = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (output !== "true") {
    throw new Error("Not a git repository.");
  }
};

export const parseNulList = (stdout: string | Buffer): string[] =>
  (Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout)
    .split("\0")
    .filter(Boolean);

export const isSafeRepoRelativePath = (value: string): boolean =>
  Boolean(value) &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  !value.split(/[\\/]+/).includes("..");

export const uniqueSafeRepoPaths = (paths: string[] | undefined): string[] => [
  ...new Set((paths ?? []).filter(isSafeRepoRelativePath)),
];

export const normalizePathspecs = (paths: string[] | undefined): string[] => {
  if (!paths || paths.length === 0) return [];
  return Array.from(
    new Set(paths.map((entry) => normalizeGitPath(entry)).filter(Boolean)),
  );
};
