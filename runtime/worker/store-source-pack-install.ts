import { promises as fsPromises } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { StoreReleaseSourcePack } from "../contracts/index.js";
import {
  sourceBlobFromBuffer,
  type StellaSourceTree,
} from "../kernel/self-mod/stella-source-control.js";

export const normalizeStoreSourcePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error(`Unsafe source-pack path: ${value}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe source-pack path: ${value}`);
  }
  return segments.join("/");
};

export const STORE_PUBLISH_DEPENDENCY_FILE_NAMES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
] as const;

const DEPENDENCY_FILE_NAMES = new Set<string>(
  STORE_PUBLISH_DEPENDENCY_FILE_NAMES,
);

type ProcessRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const runProcess = (
  cwd: string,
  command: string,
  args: string[],
): Promise<ProcessRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

const candidateBunCommands = (): string[] => {
  const seen = new Set<string>();
  const add = (candidate: string | null | undefined) => {
    const value = candidate?.trim();
    if (value) seen.add(value);
  };
  add(process.env.STELLA_BUN_PATH);
  add(process.env.BUN_PATH);
  add("bun");
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    add(
      path.join(
        homeDir,
        ".bun",
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      ),
    );
  }
  return [...seen];
};

export const storePublishTouchesDependencyFiles = (
  filePaths: string[],
): boolean =>
  filePaths.some((filePath) =>
    DEPENDENCY_FILE_NAMES.has(
      path.basename(normalizeStoreSourcePath(filePath)),
    ),
  );

export const runStorePublishDependencyInstall = async (
  repoRoot: string,
): Promise<void> => {
  let installResult: ProcessRunResult | null = null;
  let lastMissingBunError: Error | null = null;
  for (const bunCommand of candidateBunCommands()) {
    try {
      installResult = await runProcess(repoRoot, bunCommand, [
        "install",
        "--frozen-lockfile",
      ]);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastMissingBunError = error as Error;
        continue;
      }
      throw error;
    }
  }
  if (!installResult) {
    throw new Error(
      lastMissingBunError
        ? "Dependency install failed because Bun is not available."
        : "Dependency install failed because no Bun command was configured.",
    );
  }
  if (installResult.exitCode !== 0) {
    const detail = (installResult.stderr || installResult.stdout).trim();
    throw new Error(
      detail
        ? `Dependency install failed: ${detail}`
        : `Dependency install failed with exit code ${installResult.exitCode}.`,
    );
  }
};

export const storeSourcePathToAbsolute = (
  repoRoot: string,
  filePath: string,
): string => {
  const normalized = normalizeStoreSourcePath(filePath);
  const absolute = path.resolve(repoRoot, normalized);
  const root = path.resolve(repoRoot);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe source-pack path: ${filePath}`);
  }
  return absolute;
};

export type StoreSourcePackApplyObstruction = {
  path: string;
  reason: string;
};

type SourcePathTrackedChecker = (path: string) => Promise<boolean>;

const defaultSourcePathTrackedChecker = async (
  repoRoot: string,
  sourcePath: string,
): Promise<boolean> => {
  const result = await runProcess(repoRoot, "git", [
    "ls-files",
    "--error-unmatch",
    "--",
    sourcePath,
  ]);
  return result.exitCode === 0;
};

const lstatOrNull = async (filePath: string) =>
  fsPromises.lstat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });

export const findStoreSourcePackApplyObstruction = async (args: {
  repoRoot: string;
  paths: string[];
  isPathTracked?: SourcePathTrackedChecker;
}): Promise<StoreSourcePackApplyObstruction | null> => {
  const root = path.resolve(args.repoRoot);
  const isPathTracked =
    args.isPathTracked ??
    ((sourcePath: string) =>
      defaultSourcePathTrackedChecker(args.repoRoot, sourcePath));

  for (const sourcePath of args.paths) {
    const normalized = normalizeStoreSourcePath(sourcePath);
    storeSourcePathToAbsolute(args.repoRoot, normalized);
    const segments = normalized.split("/");
    let current = root;

    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      const stat = await lstatOrNull(current);
      if (!stat) break;

      const relative = path.relative(root, current).replace(/\\/g, "/");
      if (stat.isSymbolicLink()) {
        return {
          path: normalized,
          reason: `Source-pack path ${normalized} crosses symlink ${relative}.`,
        };
      }

      const isFinalSegment = index === segments.length - 1;
      if (!isFinalSegment && !stat.isDirectory()) {
        return {
          path: normalized,
          reason: `Source-pack path ${normalized} is blocked by non-directory parent ${relative}.`,
        };
      }

      if (isFinalSegment) {
        if (stat.isDirectory()) {
          return {
            path: normalized,
            reason: `Source-pack path ${normalized} is blocked by an existing directory.`,
          };
        }

        if (!(await isPathTracked(normalized))) {
          return {
            path: normalized,
            reason: `Source-pack path ${normalized} is blocked by an untracked file.`,
          };
        }
      }
    }
  }

  return null;
};

export const collectSourcePackPaths = (
  sourcePack: StoreReleaseSourcePack,
): string[] =>
  Array.from(
    new Set(
      sourcePack.changeSets.flatMap((changeSet) =>
        changeSet.changes.map((change) =>
          normalizeStoreSourcePath(change.path),
        ),
      ),
    ),
  ).sort();

export const readLocalSourceTree = async (
  repoRoot: string,
  paths: string[],
): Promise<StellaSourceTree> => {
  const tree: StellaSourceTree = {};
  for (const filePath of paths) {
    const absolute = storeSourcePathToAbsolute(repoRoot, filePath);
    const buffer = await fsPromises.readFile(absolute).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!buffer) continue;
    tree[filePath] = sourceBlobFromBuffer(buffer);
  }
  return tree;
};

export const writeSourcePackApplyResult = async (args: {
  repoRoot: string;
  paths: string[];
  tree: StellaSourceTree;
  appliedPaths: string[];
}): Promise<void> => {
  const applied = new Set(args.appliedPaths);
  for (const filePath of args.paths) {
    if (!applied.has(filePath)) continue;
    const absolute = storeSourcePathToAbsolute(args.repoRoot, filePath);
    const blob = args.tree[filePath];
    if (!blob) {
      await fsPromises.rm(absolute, { force: true });
      continue;
    }
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    if (blob.kind === "text") {
      await fsPromises.writeFile(absolute, blob.content, "utf8");
    } else {
      await fsPromises.writeFile(
        absolute,
        Buffer.from(blob.contentBase64, "base64"),
      );
    }
  }
};
