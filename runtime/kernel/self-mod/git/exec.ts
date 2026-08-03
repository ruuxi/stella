import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupGitEnvironment } from "../../../git-environment.js";

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

/**
 * Ref/index-lock contention emitted by git when two processes update the same
 * repo at once. These are transient — the losing command did NOT mutate the
 * ref (the lock guards the update), so retrying the exact same invocation is
 * safe and idempotent. Matches the reported HEAD collision plus the sibling
 * `*.lock` "File exists" family.
 *
 *   fatal: cannot lock ref 'HEAD': is at <sha> but expected <sha>
 *   fatal: Unable to create '<repo>/.git/index.lock': File exists.
 *
 * The ref-lock race is caught by the `cannot lock ref … but expected` phrasing
 * (and the sibling `*.lock` alternatives). A bare `but expected <sha>` clause
 * is deliberately NOT matched on its own: it also appears in object-corruption
 * errors (e.g. `error: sha1 mismatch … but expected …`) which are genuinely
 * broken repos, not transient contention, and must not be retried 8×.
 */
const REF_LOCK_CONTENTION_PATTERN =
  /cannot lock ref .* but expected|unable to (?:create|lock) [^\n]*\.lock|\.lock': File exists|another git process seems to be running/i;

export const isRefLockContentionOutput = (
  stderr: string | Buffer | undefined,
  stdout?: string | Buffer | undefined,
): boolean => {
  const text = `${toTrimmedString(stderr)}\n${toTrimmedString(stdout)}`;
  return REF_LOCK_CONTENTION_PATTERN.test(text);
};

// Bounded retry-with-backoff on ref-lock contention. This is the safety net
// under the per-repo commit lock (see commit-lock.ts): even if the advisory
// lock is bypassed (external `git`, lock gap, worker-restart overlap) the
// commit self-heals instead of aborting the agent's task. ~8 attempts with
// jittered exponential backoff caps total added latency near ~2s.
const REF_LOCK_MAX_ATTEMPTS = 8;
const REF_LOCK_BASE_DELAY_MS = 40;
const REF_LOCK_MAX_DELAY_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const refLockBackoffMs = (attempt: number): number => {
  const ceiling = Math.min(
    REF_LOCK_MAX_DELAY_MS,
    REF_LOCK_BASE_DELAY_MS * 2 ** attempt,
  );
  // Full jitter: uniformly random within [0, ceiling] to de-synchronize
  // multiple losers colliding on the same lock.
  return Math.floor(Math.random() * ceiling);
};

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
  const { env, gitLocation } = setupGitEnvironment(options?.env);
  let attempt = 0;
  for (;;) {
    try {
      const result = await execFileAsync(gitLocation, args, {
        cwd: repoRoot,
        env,
        encoding,
        maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
        windowsHide: true,
        // Self-mod git calls run on hot paths — including run finalization
        // (detectAppliedSince fires on every successful orchestrator turn).
        // An unbounded hang here silently withholds RUN_FINISHED and the
        // whole conversation reads as "busy" forever after the reply. All
        // commands this module issues are local (no clone/fetch/push), so a
        // minute is generous headroom even for large-tree resets/commits.
        timeout: 60_000,
        killSignal: "SIGKILL",
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const err = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: unknown;
      };
      const stdout =
        err.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : "");
      const stderr =
        err.stderr ?? (encoding === "buffer" ? Buffer.alloc(0) : "");
      if (
        attempt < REF_LOCK_MAX_ATTEMPTS - 1 &&
        isRefLockContentionOutput(stderr, stdout)
      ) {
        attempt += 1;
        await sleep(refLockBackoffMs(attempt));
        continue;
      }
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout,
        stderr,
      };
    }
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
