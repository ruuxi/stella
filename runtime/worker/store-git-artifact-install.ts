import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { setupEnvironment } from "dugite";
import type {
  StoreInstallRecord,
  StoreReleaseGitArtifact,
} from "../contracts/index.js";
import { listGitDirtyFiles } from "../kernel/self-mod/git/log.js";
import type { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import type {
  SourceImportApplyMode,
  SourceImportLifecycle,
} from "./source-import.js";
import { runGit, runGitStatus, toText } from "./git-exec.js";
import {
  applyMergedTreeToWorkingTree,
  computeCleanMergeTree,
  runMechanicalApplyWithLifecycle,
} from "./mechanical-apply.js";

const execFileAsync = promisify(execFile);
const STORE_GIT_OBJECT_DOWNLOAD_CONCURRENCY = 8;
const STORE_GIT_OBJECT_MAX_INFLATED_BYTES = 50 * 1024 * 1024;

type GitObjectUrl = {
  sha: string;
  r2Key: string;
  downloadUrl: string;
};

type StoreGitArtifactFastPathResult =
  | {
      status: "applied";
      installRecord: StoreInstallRecord;
    }
  | {
      status: "needs-agent";
      reason: string;
    };

const mapConcurrent = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (index < values.length) {
        const current = index;
        index += 1;
        results[current] = await mapper(values[current]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const gitDirForRepo = async (repoRoot: string): Promise<string> => {
  const gitDir = await runGit(repoRoot, ["rev-parse", "--git-dir"]);
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(repoRoot, gitDir);
};

const objectExistsLocally = async (
  repoRoot: string,
  sha: string,
): Promise<boolean> => {
  const result = await runGitStatus(repoRoot, [
    "cat-file",
    "-e",
    `${sha}^{object}`,
  ]);
  return result.exitCode === 0;
};

const parseInflatedGitObject = (args: {
  sha: string;
  compressedBytes: Uint8Array;
}): { type: "blob" | "tree" | "commit"; storeBytes: Buffer } => {
  const storeBytes = inflateSync(args.compressedBytes);
  if (storeBytes.byteLength > STORE_GIT_OBJECT_MAX_INFLATED_BYTES) {
    throw new Error(
      `Git object ${args.sha} is too large for Store fast-path install.`,
    );
  }
  const nulIndex = storeBytes.indexOf(0);
  if (nulIndex <= 0) {
    throw new Error(`Git object ${args.sha} has an invalid header.`);
  }
  const header = storeBytes.subarray(0, nulIndex).toString("utf8");
  const match = /^(blob|tree|commit) ([0-9]+)$/.exec(header);
  if (!match) {
    throw new Error(`Git object ${args.sha} has an unsupported header.`);
  }
  const size = Number(match[2]);
  const contentSize = storeBytes.byteLength - nulIndex - 1;
  if (!Number.isInteger(size) || size !== contentSize) {
    throw new Error(`Git object ${args.sha} size does not match its header.`);
  }
  const computed = createHash("sha1").update(storeBytes).digest("hex");
  if (computed !== args.sha) {
    throw new Error(`Git object ${args.sha} failed integrity verification.`);
  }
  return {
    type: match[1] as "blob" | "tree" | "commit",
    storeBytes,
  };
};

const writeLooseObject = async (args: {
  objectRoot: string;
  sha: string;
  compressedBytes: Uint8Array;
}): Promise<void> => {
  const dir = path.join(args.objectRoot, args.sha.slice(0, 2));
  const file = path.join(dir, args.sha.slice(2));
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(file, args.compressedBytes);
};

const runGitWithObjectEnv = async (args: {
  repoRoot: string;
  gitObjectDirectory: string;
  alternateObjectDirectory: string;
  gitArgs: string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const { env, gitLocation } = setupEnvironment({
    ...process.env,
    GIT_OBJECT_DIRECTORY: args.gitObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.alternateObjectDirectory,
  });
  try {
    const result = await execFileAsync(gitLocation, args.gitArgs, {
      cwd: args.repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
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

const runGitBuffer = async (
  repoRoot: string,
  gitArgs: string[],
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> => {
  const { env, gitLocation } = setupEnvironment({ ...process.env });
  try {
    const result = await execFileAsync(gitLocation, gitArgs, {
      cwd: repoRoot,
      env,
      encoding: "buffer",
      maxBuffer: STORE_GIT_OBJECT_MAX_INFLATED_BYTES + 1024,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout),
      stderr: toText(result.stderr),
    };
  } catch (error) {
    const err = error as {
      code?: unknown;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const stderr = toText(err.stderr) || err.message || "";
    if (/maxBuffer/i.test(stderr)) {
      return {
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: "Store Git reference file is too large to materialize.",
      };
    }
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: Buffer.isBuffer(err.stdout)
        ? err.stdout
        : Buffer.from(err.stdout ?? ""),
      stderr,
    };
  }
};

const fetchAndPromoteMissingObjects = async (args: {
  repoRoot: string;
  gitArtifact: StoreReleaseGitArtifact;
  getObjectUrls: (shas: string[]) => Promise<GitObjectUrl[]>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<void> => {
  const missing: string[] = [];
  const objectBySha = new Map(
    args.gitArtifact.objects.map((object) => [object.sha, object]),
  );
  const localObjectChecks = await mapConcurrent(
    args.gitArtifact.objects,
    STORE_GIT_OBJECT_DOWNLOAD_CONCURRENCY,
    async (object) => ({
      sha: object.sha,
      exists: await objectExistsLocally(args.repoRoot, object.sha),
    }),
  );
  for (const check of localObjectChecks) {
    if (!check.exists) missing.push(check.sha);
  }
  if (missing.length === 0) return;

  const gitDir = await gitDirForRepo(args.repoRoot);
  const repoObjectDir = path.join(gitDir, "objects");
  const tempRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "stella-store-objects-"),
  );
  const quarantineObjectDir = path.join(tempRoot, "objects");
  try {
    await fsPromises.mkdir(quarantineObjectDir, { recursive: true });
    const urls = await args.getObjectUrls(missing);
    const urlBySha = new Map(urls.map((url) => [url.sha, url]));
    await mapConcurrent(
      missing,
      STORE_GIT_OBJECT_DOWNLOAD_CONCURRENCY,
      async (sha) => {
        const url = urlBySha.get(sha);
        if (!url) {
          throw new Error(
            `Store release did not return a download URL for ${sha}.`,
          );
        }
        const response = await fetch(url.downloadUrl);
        if (!response.ok) {
          throw new Error(
            `Could not download Store Git object ${sha} (${response.status}).`,
          );
        }
        const compressedBytes = new Uint8Array(await response.arrayBuffer());
        const expected = objectBySha.get(sha);
        if (!expected) {
          throw new Error(`Store release object manifest is missing ${sha}.`);
        }
        if (compressedBytes.byteLength !== expected.sizeBytes) {
          throw new Error(
            `Git object ${sha} size does not match the release manifest.`,
          );
        }
        const parsed = parseInflatedGitObject({ sha, compressedBytes });
        if (parsed.type !== expected.type) {
          throw new Error(
            `Git object ${sha} type does not match the release manifest.`,
          );
        }
        await writeLooseObject({
          objectRoot: quarantineObjectDir,
          sha,
          compressedBytes,
        });
      },
    );

    const fsck = await runGitWithObjectEnv({
      repoRoot: args.repoRoot,
      gitObjectDirectory: quarantineObjectDir,
      alternateObjectDirectory: repoObjectDir,
      gitArgs: [
        "fsck",
        "--connectivity-only",
        "--no-dangling",
        args.gitArtifact.featureCommit,
      ],
    });
    if (fsck.exitCode !== 0) {
      throw new Error(
        `Store Git artifact failed connectivity verification: ${
          fsck.stderr.trim() ||
          fsck.stdout.trim() ||
          `exit code ${fsck.exitCode}`
        }`,
      );
    }

    for (const sha of missing) {
      if (await objectExistsLocally(args.repoRoot, sha)) continue;
      const source = path.join(
        quarantineObjectDir,
        sha.slice(0, 2),
        sha.slice(2),
      );
      const destinationDir = path.join(repoObjectDir, sha.slice(0, 2));
      const destination = path.join(destinationDir, sha.slice(2));
      await fsPromises.mkdir(destinationDir, { recursive: true });
      await fsPromises.copyFile(source, destination);
    }
    args.log?.("store-git-artifact.objects.promoted", {
      objectCount: missing.length,
    });
  } finally {
    await fsPromises
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
};

export const materializeStoreGitArtifactReference = async (args: {
  repoRoot: string;
  gitArtifact: StoreReleaseGitArtifact;
  outputRoot: string;
}): Promise<string | null> => {
  const result = await runGitStatus(args.repoRoot, [
    "diff",
    "--name-only",
    "-z",
    args.gitArtifact.baseCommit,
    args.gitArtifact.featureCommit,
  ]);
  if (result.exitCode !== 0) return null;
  const files = result.stdout.split("\0").filter(Boolean);
  if (files.length === 0) return null;
  const root = path.join(args.outputRoot, "AUTHOR_TREE");
  await fsPromises
    .rm(root, { recursive: true, force: true })
    .catch(() => undefined);
  await fsPromises.mkdir(root, { recursive: true });
  for (const filePath of files) {
    const blobSha = await runGitStatus(args.repoRoot, [
      "rev-parse",
      `${args.gitArtifact.featureCommit}:${filePath}`,
    ]);
    if (blobSha.exitCode !== 0) continue;
    const show = await runGitBuffer(args.repoRoot, [
      "cat-file",
      "blob",
      blobSha.stdout.trim(),
    ]);
    if (show.exitCode !== 0) continue;
    const destination = path.join(root, filePath);
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    await fsPromises.writeFile(destination, show.stdout);
  }
  return root;
};

export const tryStoreGitArtifactFastPath = async (args: {
  repoRoot: string;
  service: StoreModService;
  packageId: string;
  releaseNumber: number;
  displayName: string;
  gitArtifact: StoreReleaseGitArtifact;
  getObjectUrls: (shas: string[]) => Promise<GitObjectUrl[]>;
  applyMode: SourceImportApplyMode;
  lifecycle?: SourceImportLifecycle;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<StoreGitArtifactFastPathResult> => {
  const dirtyFiles = await listGitDirtyFiles(args.repoRoot);
  if (dirtyFiles.length > 0) {
    return {
      status: "needs-agent",
      reason: "The install tree has local working-tree changes.",
    };
  }

  try {
    await fetchAndPromoteMissingObjects({
      repoRoot: args.repoRoot,
      gitArtifact: args.gitArtifact,
      getObjectUrls: args.getObjectUrls,
      log: args.log,
    });
  } catch (error) {
    return {
      status: "needs-agent",
      reason: (error as Error).message,
    };
  }

  const featureExists = await runGitStatus(args.repoRoot, [
    "cat-file",
    "-e",
    `${args.gitArtifact.featureCommit}^{commit}`,
  ]);
  if (featureExists.exitCode !== 0) {
    return {
      status: "needs-agent",
      reason: "The Store feature commit is not available locally.",
    };
  }

  const merge = await computeCleanMergeTree({
    repoRoot: args.repoRoot,
    mergeRef: args.gitArtifact.featureCommit,
  });
  if (merge.status === "needs-agent") {
    return merge;
  }
  if (merge.status === "no-changes") {
    return {
      status: "applied",
      installRecord: args.service.recordInstall({
        packageId: args.packageId,
        releaseNumber: args.releaseNumber,
        installCommitHash: null,
        sourceRevisionId: `git:${args.gitArtifact.featureCommit}`,
      }),
    };
  }

  const conversationId = `store-install:${args.packageId}`;
  const result = await runMechanicalApplyWithLifecycle({
    runId: `store-git-import:${args.packageId}:${randomUUID()}`,
    conversationId,
    repoRoot: args.repoRoot,
    service: args.service,
    begin: {
      taskDescription: `${args.applyMode === "update" ? "Update" : "Install"} ${args.displayName} from Store`,
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      applyMode: args.applyMode,
    },
    changedPaths: merge.changedPaths,
    lifecycle: args.lifecycle,
    apply: () =>
      applyMergedTreeToWorkingTree({
        repoRoot: args.repoRoot,
        treeHash: merge.treeHash,
        changes: merge.changes,
      }),
    noCommitError:
      "Store git import wrote changes but did not create an install commit.",
  });

  return {
    status: "applied",
    installRecord: args.service.recordInstall({
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      installCommitHash: result.commitHash,
      sourceRevisionId: result.sourceRevisionId ?? null,
      sourceRevisionIds: [`git:${args.gitArtifact.featureCommit}`],
    }),
  };
};
