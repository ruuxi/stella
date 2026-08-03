import { spawn } from "node:child_process";
import { setupGitEnvironment } from "../../../git-environment.js";
import {
  assertGitRepository,
  normalizeGitPath,
  runGitStatus,
  toTrimmedString,
} from "./exec.js";

export const getCommitFileSnapshot = async (args: {
  repoRoot: string;
  commitHash: string;
  filePath: string;
}): Promise<{ path: string; deleted: boolean; contentBase64?: string }> => {
  await assertGitRepository(args.repoRoot);
  const gitPath = normalizeGitPath(args.filePath);
  const result = await runGitStatus(
    args.repoRoot,
    ["show", `${args.commitHash}:${gitPath}`],
    {
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024,
    },
  );
  if (result.exitCode === 0) {
    const buffer = Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout);
    return {
      path: gitPath,
      deleted: false,
      contentBase64: buffer.toString("base64"),
    };
  }
  if (result.exitCode === 128) {
    return {
      path: gitPath,
      deleted: true,
    };
  }
  const details =
    toTrimmedString(result.stderr) ||
    toTrimmedString(result.stdout) ||
    `exit code ${result.exitCode}`;
  throw new Error(
    `Git command failed (show ${args.commitHash}:${gitPath}): ${details}`,
  );
};

const CAT_FILE_MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * Read many git objects in ONE `git cat-file --batch` subprocess.
 *
 * `specs` are revision:path specs (e.g. `"<commit>:src/foo.ts"`); the
 * returned map is keyed by the input spec. Missing objects (deleted /
 * never-existed paths) map to `null`. Responses arrive in input order,
 * which is how we correlate them — cat-file echoes the resolved oid,
 * not the input spec, for found objects.
 */
export const readGitObjectsBatch = async (args: {
  repoRoot: string;
  specs: string[];
}): Promise<Map<string, Buffer | null>> => {
  const result = new Map<string, Buffer | null>();
  const specs = args.specs.filter(Boolean);
  if (specs.length === 0) return result;
  await assertGitRepository(args.repoRoot);

  const { env, gitLocation } = setupGitEnvironment();
  const stdout = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(gitLocation, ["cat-file", "--batch"], {
      cwd: args.repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `Git command failed (cat-file --batch): ${
              Buffer.concat(errChunks).toString("utf8").trim() ||
              `exit code ${code}`
            }`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(outChunks));
    });
    child.stdin.on("error", fail);
    child.stdin.end(`${specs.join("\n")}\n`);
  });

  let offset = 0;
  for (const spec of specs) {
    const headerEnd = stdout.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error(
        "Git command failed (cat-file --batch): truncated batch output.",
      );
    }
    const header = stdout.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;
    const found = /^(\S+) (blob|tree|commit|tag) (\d+)$/.exec(header);
    if (!found) {
      // `<spec> missing` (or ambiguous) — no body follows.
      result.set(spec, null);
      continue;
    }
    const size = Number(found[3]);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(
        `Git command failed (cat-file --batch): invalid object size in "${header}".`,
      );
    }
    if (size > CAT_FILE_MAX_OBJECT_BYTES) {
      throw new Error(
        `Git object for ${spec} is too large (${size} bytes) to snapshot.`,
      );
    }
    result.set(spec, Buffer.from(stdout.subarray(offset, offset + size)));
    // +1 skips the trailing LF after the object body.
    offset += size + 1;
  }
  return result;
};
