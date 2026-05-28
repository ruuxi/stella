#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder, TextEncoder } from "node:util";

const MAX_SOURCE_PACK_BYTES = 10 * 1024 * 1024;
const TEXT_FILE_LIMIT = 750_000;
const BINARY_FILE_LIMIT = 1_500_000;
const encoder = new TextEncoder();

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(key.slice(2), "true");
    continue;
  }
  args.set(key.slice(2), next);
  index += 1;
}

const outputPath = args.get("output");
if (!outputPath) {
  throw new Error("--output is required.");
}
const historyOutputPath = args.get("history-output");

const targetRef = args.get("target") ?? "HEAD";
const tag = args.get("tag") ?? targetRef;
const explicitBase = args.get("base");
const maxBytes = Number(args.get("max-bytes") ?? MAX_SOURCE_PACK_BYTES);

const git = (gitArgs, options = {}) =>
  execFileSync("git", gitArgs, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });

const gitMaybe = (gitArgs, options = {}) => {
  try {
    return git(gitArgs, options);
  } catch {
    return null;
  }
};

const resolveCommit = (ref) => git(["rev-parse", ref]).trim();

const targetCommit = resolveCommit(targetRef);
const baseRef =
  explicitBase ??
  gitMaybe([
    "describe",
    "--tags",
    "--match",
    "desktop-v*",
    "--abbrev=0",
    `${targetCommit}^`,
  ])?.trim();

if (!baseRef) {
  console.log("No previous desktop release tag found; source pack skipped.");
  process.exit(0);
}

const baseCommit = resolveCommit(baseRef);
if (baseCommit === targetCommit) {
  console.log("Desktop source pack skipped because base and target match.");
  process.exit(0);
}

const normalizePath = (value) =>
  value.trim().replace(/\\/g, "/").replace(/^\/+/, "");

const excludedPrefixes = [
  ".git/",
  ".stella/electron-user-data/",
  "node_modules/",
  "release-root/",
  "release-assets/",
  "desktop/dist/",
  "desktop/dist-electron/",
  "desktop/native/out/",
  "desktop/stella-browser/bin/",
  "desktop/stella-office/bin/",
];

const excludedSuffixes = [".tar", ".tar.gz", ".tar.zst", ".zip", ".dmg"];

const shouldIncludePath = (filePath) => {
  const normalized = normalizePath(filePath);
  if (!normalized || normalized.startsWith("../")) return false;
  if (excludedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (excludedSuffixes.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }
  if (/^desktop\/resources\/models\/.+\.onnx$/i.test(normalized)) {
    return false;
  }
  return true;
};

const changedPaths = () => {
  const stdout = git([
    "diff",
    "--name-status",
    "--find-renames",
    baseCommit,
    targetCommit,
    "--",
  ]);
  const paths = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R")) {
      if (parts[1] && shouldIncludePath(parts[1]))
        paths.add(normalizePath(parts[1]));
      if (parts[2] && shouldIncludePath(parts[2]))
        paths.add(normalizePath(parts[2]));
      continue;
    }
    const filePath = parts[1];
    if (filePath && shouldIncludePath(filePath))
      paths.add(normalizePath(filePath));
  }
  return [...paths].sort();
};

const gitBlobObjectId = (revision, filePath) =>
  gitMaybe(["rev-parse", `${revision}:${filePath}`])?.trim() ?? null;

const gitBlobSize = (revision, filePath) => {
  const stdout = gitMaybe(["cat-file", "-s", `${revision}:${filePath}`]);
  if (!stdout) return null;
  const size = Number(stdout.trim());
  return Number.isFinite(size) && size >= 0 ? size : null;
};

const hashGitBlobObject = (objectId) =>
  objectId ? `git-blob:${objectId}` : null;

const readGitBlobBuffer = (revision, filePath) => {
  const result = gitMaybe(["show", `${revision}:${filePath}`], {
    encoding: "buffer",
    maxBuffer: BINARY_FILE_LIMIT + 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!result) return undefined;
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
};

const inspectGitBlob = (revision, filePath) => {
  const objectId = gitBlobObjectId(revision, filePath);
  if (!objectId) return { hash: null };
  const size = gitBlobSize(revision, filePath);
  if (size != null && size > BINARY_FILE_LIMIT) {
    return { hash: hashGitBlobObject(objectId) };
  }
  const buffer = readGitBlobBuffer(revision, filePath);
  if (!buffer) return { hash: hashGitBlobObject(objectId) };
  if (buffer.includes(0)) {
    const contentBase64 = buffer.toString("base64");
    return {
      hash:
        buffer.length <= BINARY_FILE_LIMIT
          ? hashSourceBlob({ kind: "binary", contentBase64 })
          : hashGitBlobObject(objectId),
      ...(buffer.length <= BINARY_FILE_LIMIT
        ? { blob: { kind: "binary", contentBase64 } }
        : {}),
    };
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (decoded.includes("\uFFFD")) {
    const contentBase64 = buffer.toString("base64");
    return {
      hash:
        buffer.length <= BINARY_FILE_LIMIT
          ? hashSourceBlob({ kind: "binary", contentBase64 })
          : hashGitBlobObject(objectId),
      ...(buffer.length <= BINARY_FILE_LIMIT
        ? { blob: { kind: "binary", contentBase64 } }
        : {}),
    };
  }
  return {
    hash:
      buffer.length <= TEXT_FILE_LIMIT
        ? hashSourceBlob({ kind: "text", content: decoded })
        : hashGitBlobObject(objectId),
    ...(buffer.length <= TEXT_FILE_LIMIT
      ? { blob: { kind: "text", content: decoded } }
      : {}),
  };
};

const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
};

const sha256 = (parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
};

const hashSourceBlob = (blob) => {
  if (!blob) return null;
  if (blob.kind === "text") {
    return sha256([
      "stella-source-blob-v1\0text\0",
      encoder.encode(blob.content),
    ]);
  }
  return sha256([
    "stella-source-blob-v1\0binary\0",
    encoder.encode(blob.contentBase64),
  ]);
};

const buildRevisionId = (changeSet) =>
  sha256([
    "stella-source-revision-v1\0",
    stableJson({
      baseRevisionId: changeSet.baseRevisionId,
      parentRevisionIds: [...changeSet.parentRevisionIds].sort(),
      featureId: changeSet.featureId ?? null,
      description: changeSet.description ?? null,
      changes: changeSet.changes.map((change) => ({
        path: change.path,
        baseHash: change.baseHash,
        nextHash: change.nextHash,
      })),
    }),
  ]);

const paths = changedPaths();
const changes = [];
for (const filePath of paths) {
  const base = inspectGitBlob(baseCommit, filePath);
  const next = inspectGitBlob(targetCommit, filePath);
  if (!base.hash && !next.hash) continue;
  changes.push({
    path: filePath,
    baseHash: base.hash,
    nextHash: next.hash,
    ...(base.blob ? { base: base.blob } : {}),
    ...(next.blob ? { next: next.blob } : {}),
  });
}

if (changes.length === 0) {
  console.log(
    "Desktop source pack skipped because no eligible source changes were found.",
  );
  process.exit(0);
}

const baseRevisionId = `git:${baseCommit}`;
const changeSet = {
  schemaVersion: 1,
  baseRevisionId,
  parentRevisionIds: [baseRevisionId],
  revisionId: "",
  featureId: "desktop-release",
  description: `Desktop release ${tag}`,
  changes,
};
changeSet.revisionId = buildRevisionId(changeSet);

const pack = {
  kind: "stella-source-pack",
  schemaVersion: 1,
  baseRevisionId,
  revisionId: changeSet.revisionId,
  featureId: "desktop-release",
  description: `Desktop release ${tag}`,
  changeSets: [changeSet],
};

const stripPackContent = (sourcePack) => ({
  ...sourcePack,
  changeSets: sourcePack.changeSets.map((sourceChangeSet) => ({
    ...sourceChangeSet,
    changes: sourceChangeSet.changes.map((change) => ({
      path: change.path,
      baseHash: change.baseHash,
      nextHash: change.nextHash,
    })),
  })),
});

if (historyOutputPath) {
  const historyJson = `${JSON.stringify(stripPackContent(pack), null, 2)}\n`;
  mkdirSync(path.dirname(historyOutputPath), { recursive: true });
  writeFileSync(historyOutputPath, historyJson, "utf8");
  console.log(
    `Wrote ${historyOutputPath} (${changes.length} changed paths, ${statSync(historyOutputPath).size} bytes).`,
  );
}

const json = `${JSON.stringify(pack, null, 2)}\n`;
if (Buffer.byteLength(json, "utf8") > maxBytes) {
  console.log(
    `Desktop source pack skipped because it is ${Buffer.byteLength(
      json,
      "utf8",
    )} bytes, above ${maxBytes}.`,
  );
  process.exit(0);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, json, "utf8");
console.log(
  `Wrote ${outputPath} (${changes.length} changed paths, ${statSync(outputPath).size} bytes).`,
);
