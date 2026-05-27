import { createHash } from "node:crypto";

export type StellaSourceBlob =
  | { kind: "text"; content: string }
  | { kind: "binary"; contentBase64: string };

export type StellaSourceTree = Record<string, StellaSourceBlob>;

export type StellaSourceChange = {
  path: string;
  baseHash: string | null;
  nextHash: string | null;
  /**
   * Source packs include the touched-path base content so Stella can do a
   * local three-way merge without cloning the author's full tree. History-only
   * manifests may omit it and still preserve the same revision id.
   */
  base?: StellaSourceBlob;
  /**
   * Present for source packs that can be applied locally. History-only packs
   * may omit this and still produce the same revision id because the hash is
   * the stable identity.
   */
  next?: StellaSourceBlob;
};

export type StellaSourceChangeSet = {
  schemaVersion: 1;
  baseRevisionId: string;
  parentRevisionIds: string[];
  revisionId: string;
  featureId?: string;
  description?: string;
  changes: StellaSourceChange[];
};

export type StellaSourcePack = {
  kind: "stella-source-pack";
  schemaVersion: 1;
  baseRevisionId: string;
  revisionId: string;
  featureId?: string;
  description?: string;
  changeSets: StellaSourceChangeSet[];
};

export type StellaSourceApplyConflict = {
  path: string;
  reason:
    | "base-history-mismatch"
    | "missing-incoming-content"
    | "text-conflict"
    | "binary-or-delete-conflict";
  baseHash: string | null;
  localHash: string | null;
  incomingHash: string | null;
  base?: StellaSourceBlob;
  local?: StellaSourceBlob;
  incoming?: StellaSourceBlob;
};

export type StellaSourceApplyResult = {
  status: "clean" | "conflicts";
  revisionId: string;
  tree: StellaSourceTree;
  appliedPaths: string[];
  noopPaths: string[];
  conflicts: StellaSourceApplyConflict[];
};

type TextHunk = {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
};

export type TextMergeResult =
  | { status: "clean"; content: string }
  | {
      status: "conflict";
      base: string;
      local: string;
      incoming: string;
    };

const TEXT_ENCODER = new TextEncoder();

const normalizeSourcePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\/+/, "");

const cloneBlob = (blob: StellaSourceBlob): StellaSourceBlob =>
  blob.kind === "text"
    ? { kind: "text", content: blob.content }
    : { kind: "binary", contentBase64: blob.contentBase64 };

const cloneTree = (tree: StellaSourceTree): StellaSourceTree => {
  const next: StellaSourceTree = {};
  for (const path of Object.keys(tree).sort()) {
    next[path] = cloneBlob(tree[path]!);
  }
  return next;
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const sha256 = (parts: Array<string | Uint8Array>): string => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return `sha256:${hash.digest("hex")}`;
};

export const sourceBufferLooksText = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  return !decoded.includes("\uFFFD");
};

export const sourceBlobFromBuffer = (buffer: Buffer): StellaSourceBlob =>
  sourceBufferLooksText(buffer)
    ? { kind: "text", content: buffer.toString("utf8") }
    : { kind: "binary", contentBase64: buffer.toString("base64") };

export const hashSourceBlob = (
  blob: StellaSourceBlob | null | undefined,
): string | null => {
  if (!blob) return null;
  if (blob.kind === "text") {
    return sha256([
      "stella-source-blob-v1\0text\0",
      TEXT_ENCODER.encode(blob.content),
    ]);
  }
  return sha256([
    "stella-source-blob-v1\0binary\0",
    TEXT_ENCODER.encode(blob.contentBase64),
  ]);
};

export const hashSourceTree = (tree: StellaSourceTree): string =>
  sha256([
    "stella-source-tree-v1\0",
    stableJson(
      Object.keys(tree)
        .map((path) => normalizeSourcePath(path))
        .sort()
        .map((path) => [path, hashSourceBlob(tree[path])]),
    ),
  ]);

const buildRevisionId = (args: {
  baseRevisionId: string;
  parentRevisionIds: string[];
  featureId?: string;
  description?: string;
  changes: StellaSourceChange[];
}): string =>
  sha256([
    "stella-source-revision-v1\0",
    stableJson({
      baseRevisionId: args.baseRevisionId,
      parentRevisionIds: [...args.parentRevisionIds].sort(),
      featureId: args.featureId ?? null,
      description: args.description ?? null,
      changes: args.changes.map((change) => ({
        path: change.path,
        baseHash: change.baseHash,
        nextHash: change.nextHash,
      })),
    }),
  ]);

export const createStellaSourceChangeSet = (args: {
  baseRevisionId: string;
  parentRevisionIds?: string[];
  featureId?: string;
  description?: string;
  changes: StellaSourceChange[];
}): StellaSourceChangeSet => {
  const changes = args.changes
    .map((change) => {
      const path = normalizeSourcePath(change.path);
      if (!path) {
        throw new Error("Stella source changes must have a path.");
      }
      const nextHash = change.next
        ? hashSourceBlob(change.next)
        : change.nextHash;
      const baseHash = change.base
        ? hashSourceBlob(change.base)
        : change.baseHash;
      if (change.base && change.baseHash && baseHash !== change.baseHash) {
        throw new Error(`Base content hash does not match ${path}.`);
      }
      if (change.next && change.nextHash && nextHash !== change.nextHash) {
        throw new Error(`Incoming content hash does not match ${path}.`);
      }
      return {
        path,
        baseHash,
        nextHash,
        ...(change.base ? { base: cloneBlob(change.base) } : {}),
        ...(change.next ? { next: cloneBlob(change.next) } : {}),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    schemaVersion: 1,
    baseRevisionId: args.baseRevisionId,
    parentRevisionIds: args.parentRevisionIds ?? [args.baseRevisionId],
    revisionId: buildRevisionId({
      baseRevisionId: args.baseRevisionId,
      parentRevisionIds: args.parentRevisionIds ?? [args.baseRevisionId],
      ...(args.featureId ? { featureId: args.featureId } : {}),
      ...(args.description ? { description: args.description } : {}),
      changes,
    }),
    ...(args.featureId ? { featureId: args.featureId } : {}),
    ...(args.description ? { description: args.description } : {}),
    changes,
  };
};

export const createStellaSourceChangeSetFromTrees = (args: {
  baseRevisionId: string;
  parentRevisionIds?: string[];
  featureId?: string;
  description?: string;
  baseTree: StellaSourceTree;
  nextTree: StellaSourceTree;
}): StellaSourceChangeSet => {
  const paths = new Set([
    ...Object.keys(args.baseTree).map(normalizeSourcePath),
    ...Object.keys(args.nextTree).map(normalizeSourcePath),
  ]);
  const changes: StellaSourceChange[] = [];
  for (const filePath of Array.from(paths).sort()) {
    const base = args.baseTree[filePath];
    const next = args.nextTree[filePath];
    const baseHash = hashSourceBlob(base);
    const nextHash = hashSourceBlob(next);
    if (baseHash === nextHash) continue;
    changes.push({
      path: filePath,
      baseHash,
      nextHash,
      ...(base ? { base: cloneBlob(base) } : {}),
      ...(next ? { next: cloneBlob(next) } : {}),
    });
  }
  return createStellaSourceChangeSet({
    baseRevisionId: args.baseRevisionId,
    parentRevisionIds: args.parentRevisionIds,
    featureId: args.featureId,
    description: args.description,
    changes,
  });
};

export const createStellaSourcePack = (args: {
  baseRevisionId: string;
  featureId?: string;
  description?: string;
  changeSets: StellaSourceChangeSet[];
}): StellaSourcePack => {
  const changeSets = args.changeSets.map((changeSet) =>
    createStellaSourceChangeSet({
      baseRevisionId: changeSet.baseRevisionId,
      parentRevisionIds: changeSet.parentRevisionIds,
      featureId: changeSet.featureId,
      description: changeSet.description,
      changes: changeSet.changes,
    }),
  );
  const revisionId =
    changeSets.length > 0
      ? changeSets[changeSets.length - 1]!.revisionId
      : args.baseRevisionId;
  return {
    kind: "stella-source-pack",
    schemaVersion: 1,
    baseRevisionId: args.baseRevisionId,
    revisionId,
    ...(args.featureId ? { featureId: args.featureId } : {}),
    ...(args.description ? { description: args.description } : {}),
    changeSets,
  };
};

export const stripStellaSourceChangeSetContent = (
  changeSet: StellaSourceChangeSet,
): StellaSourceChangeSet =>
  createStellaSourceChangeSet({
    baseRevisionId: changeSet.baseRevisionId,
    parentRevisionIds: changeSet.parentRevisionIds,
    ...(changeSet.featureId ? { featureId: changeSet.featureId } : {}),
    ...(changeSet.description ? { description: changeSet.description } : {}),
    changes: changeSet.changes.map((change) => ({
      path: change.path,
      baseHash: change.baseHash,
      nextHash: change.nextHash,
    })),
  });

export const stripStellaSourcePackContent = (
  pack: StellaSourcePack,
): StellaSourcePack =>
  createStellaSourcePack({
    baseRevisionId: pack.baseRevisionId,
    ...(pack.featureId ? { featureId: pack.featureId } : {}),
    ...(pack.description ? { description: pack.description } : {}),
    changeSets: pack.changeSets.map(stripStellaSourceChangeSetContent),
  });

export const getStellaSourcePackBaseTree = (
  pack: StellaSourcePack,
): StellaSourceTree => {
  const tree: StellaSourceTree = {};
  const seenPaths = new Set<string>();
  for (const changeSet of pack.changeSets) {
    for (const change of changeSet.changes) {
      const filePath = normalizeSourcePath(change.path);
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);
      if (change.base) {
        tree[filePath] = cloneBlob(change.base);
      }
    }
  }
  return tree;
};

const splitTextLines = (content: string): string[] =>
  content.match(/[^\n]*\n|[^\n]+/g) ?? [];

const joinTextLines = (lines: string[]): string => lines.join("");

const computeTextHunks = (base: string[], target: string[]): TextHunk[] => {
  const dp = Array.from({ length: base.length + 1 }, () =>
    Array<number>(target.length + 1).fill(0),
  );
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = target.length - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        base[i] === target[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const hunks: TextHunk[] = [];
  let i = 0;
  let j = 0;
  let active: TextHunk | null = null;
  const ensureActive = () => {
    active ??= { baseStart: i, baseEnd: i, replacement: [] };
    return active;
  };
  const flush = () => {
    if (!active) return;
    hunks.push(active);
    active = null;
  };

  while (i < base.length || j < target.length) {
    if (i < base.length && j < target.length && base[i] === target[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (
      j < target.length &&
      (i === base.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)
    ) {
      ensureActive().replacement.push(target[j]!);
      j += 1;
      continue;
    }
    if (i < base.length) {
      ensureActive().baseEnd = i + 1;
      i += 1;
      continue;
    }
  }
  flush();
  return hunks;
};

const hunkIsBefore = (left: TextHunk, right: TextHunk): boolean => {
  if (left.baseEnd < right.baseStart) return true;
  if (left.baseEnd > right.baseStart) return false;
  return left.baseStart !== left.baseEnd && right.baseStart !== right.baseEnd;
};

const applyHunksToRange = (
  base: string[],
  hunks: TextHunk[],
  start: number,
  end: number,
): string[] => {
  const output: string[] = [];
  let cursor = start;
  for (const hunk of hunks) {
    output.push(...base.slice(cursor, hunk.baseStart));
    output.push(...hunk.replacement);
    cursor = hunk.baseEnd;
  }
  output.push(...base.slice(cursor, end));
  return output;
};

const collectOverlapGroup = (
  hunks: TextHunk[],
  startIndex: number,
  groupStart: number,
  groupEnd: number,
): { group: TextHunk[]; nextIndex: number; end: number } => {
  const group: TextHunk[] = [];
  let index = startIndex;
  let end = groupEnd;
  while (index < hunks.length) {
    const hunk = hunks[index]!;
    const sameInsertionPoint =
      end === groupStart &&
      hunk.baseStart === groupStart &&
      hunk.baseEnd === groupStart;
    if (hunk.baseStart >= end && !sameInsertionPoint) break;
    group.push(hunk);
    end = Math.max(end, hunk.baseEnd);
    index += 1;
  }
  return { group, nextIndex: index, end };
};

export const mergeTextContent = (
  baseContent: string,
  localContent: string,
  incomingContent: string,
): TextMergeResult => {
  if (localContent === incomingContent) {
    return { status: "clean", content: localContent };
  }
  if (localContent === baseContent) {
    return { status: "clean", content: incomingContent };
  }
  if (incomingContent === baseContent) {
    return { status: "clean", content: localContent };
  }

  const base = splitTextLines(baseContent);
  const localHunks = computeTextHunks(base, splitTextLines(localContent));
  const incomingHunks = computeTextHunks(base, splitTextLines(incomingContent));
  const output: string[] = [];
  let cursor = 0;
  let localIndex = 0;
  let incomingIndex = 0;

  while (
    localIndex < localHunks.length ||
    incomingIndex < incomingHunks.length
  ) {
    const localHunk = localHunks[localIndex];
    const incomingHunk = incomingHunks[incomingIndex];

    if (localHunk && (!incomingHunk || hunkIsBefore(localHunk, incomingHunk))) {
      output.push(...base.slice(cursor, localHunk.baseStart));
      output.push(...localHunk.replacement);
      cursor = localHunk.baseEnd;
      localIndex += 1;
      continue;
    }

    if (incomingHunk && (!localHunk || hunkIsBefore(incomingHunk, localHunk))) {
      output.push(...base.slice(cursor, incomingHunk.baseStart));
      output.push(...incomingHunk.replacement);
      cursor = incomingHunk.baseEnd;
      incomingIndex += 1;
      continue;
    }

    if (!localHunk || !incomingHunk) break;

    const groupStart = Math.min(localHunk.baseStart, incomingHunk.baseStart);
    let groupEnd = Math.max(localHunk.baseEnd, incomingHunk.baseEnd);
    const localGroup = collectOverlapGroup(
      localHunks,
      localIndex,
      groupStart,
      groupEnd,
    );
    groupEnd = Math.max(groupEnd, localGroup.end);
    const incomingGroup = collectOverlapGroup(
      incomingHunks,
      incomingIndex,
      groupStart,
      groupEnd,
    );
    groupEnd = Math.max(groupEnd, incomingGroup.end);

    const localReplacement = applyHunksToRange(
      base,
      localGroup.group,
      groupStart,
      groupEnd,
    );
    const incomingReplacement = applyHunksToRange(
      base,
      incomingGroup.group,
      groupStart,
      groupEnd,
    );
    if (
      joinTextLines(localReplacement) !== joinTextLines(incomingReplacement)
    ) {
      return {
        status: "conflict",
        base: joinTextLines(base.slice(groupStart, groupEnd)),
        local: joinTextLines(localReplacement),
        incoming: joinTextLines(incomingReplacement),
      };
    }

    output.push(...base.slice(cursor, groupStart));
    output.push(...localReplacement);
    cursor = groupEnd;
    localIndex = localGroup.nextIndex;
    incomingIndex = incomingGroup.nextIndex;
  }

  output.push(...base.slice(cursor));
  return { status: "clean", content: joinTextLines(output) };
};

export const applyStellaSourceChangeSet = (args: {
  baseTree: StellaSourceTree;
  localTree: StellaSourceTree;
  changeSet: StellaSourceChangeSet;
}): StellaSourceApplyResult => {
  const tree = cloneTree(args.localTree);
  const appliedPaths: string[] = [];
  const noopPaths: string[] = [];
  const conflicts: StellaSourceApplyConflict[] = [];

  for (const change of args.changeSet.changes) {
    const filePath = normalizeSourcePath(change.path);
    const base = args.baseTree[filePath] ?? change.base;
    const local = tree[filePath];
    const localHash = hashSourceBlob(local);
    const baseHash = hashSourceBlob(base);

    if (baseHash !== change.baseHash) {
      conflicts.push({
        path: filePath,
        reason: "base-history-mismatch",
        baseHash,
        localHash,
        incomingHash: change.nextHash,
        ...(base ? { base: cloneBlob(base) } : {}),
        ...(local ? { local: cloneBlob(local) } : {}),
        ...(change.next ? { incoming: cloneBlob(change.next) } : {}),
      });
      continue;
    }

    if (localHash === change.nextHash) {
      noopPaths.push(filePath);
      continue;
    }

    if (localHash === change.baseHash) {
      if (change.nextHash && !change.next) {
        conflicts.push({
          path: filePath,
          reason: "missing-incoming-content",
          baseHash,
          localHash,
          incomingHash: change.nextHash,
          ...(base ? { base: cloneBlob(base) } : {}),
          ...(local ? { local: cloneBlob(local) } : {}),
        });
        continue;
      }
      if (change.next) {
        tree[filePath] = cloneBlob(change.next);
      } else {
        delete tree[filePath];
      }
      appliedPaths.push(filePath);
      continue;
    }

    if (
      base?.kind === "text" &&
      local?.kind === "text" &&
      change.next?.kind === "text"
    ) {
      const merge = mergeTextContent(
        base.content,
        local.content,
        change.next.content,
      );
      if (merge.status === "clean") {
        tree[filePath] = { kind: "text", content: merge.content };
        appliedPaths.push(filePath);
        continue;
      }
      conflicts.push({
        path: filePath,
        reason: "text-conflict",
        baseHash,
        localHash,
        incomingHash: change.nextHash,
        base: { kind: "text", content: merge.base },
        local: { kind: "text", content: merge.local },
        incoming: { kind: "text", content: merge.incoming },
      });
      continue;
    }

    conflicts.push({
      path: filePath,
      reason: "binary-or-delete-conflict",
      baseHash,
      localHash,
      incomingHash: change.nextHash,
      ...(base ? { base: cloneBlob(base) } : {}),
      ...(local ? { local: cloneBlob(local) } : {}),
      ...(change.next ? { incoming: cloneBlob(change.next) } : {}),
    });
  }

  return {
    status: conflicts.length > 0 ? "conflicts" : "clean",
    revisionId: args.changeSet.revisionId,
    tree,
    appliedPaths,
    noopPaths,
    conflicts,
  };
};

export const applyStellaSourceChangeSetSequence = (args: {
  baseTree: StellaSourceTree;
  localTree: StellaSourceTree;
  changeSets: StellaSourceChangeSet[];
}): StellaSourceApplyResult => {
  let referenceTree = cloneTree(args.baseTree);
  let localTree = cloneTree(args.localTree);
  const appliedPaths: string[] = [];
  const noopPaths: string[] = [];
  const conflicts: StellaSourceApplyConflict[] = [];
  let revisionId = hashSourceTree(args.baseTree);

  for (const changeSet of args.changeSets) {
    revisionId = changeSet.revisionId;
    const localResult = applyStellaSourceChangeSet({
      baseTree: referenceTree,
      localTree,
      changeSet,
    });
    appliedPaths.push(...localResult.appliedPaths);
    noopPaths.push(...localResult.noopPaths);
    conflicts.push(...localResult.conflicts);
    localTree = localResult.tree;

    if (localResult.status === "conflicts") {
      break;
    }

    const nextReference = applyStellaSourceChangeSet({
      baseTree: referenceTree,
      localTree: referenceTree,
      changeSet,
    });
    if (nextReference.status === "conflicts") {
      conflicts.push(...nextReference.conflicts);
      break;
    }
    referenceTree = nextReference.tree;
  }

  return {
    status: conflicts.length > 0 ? "conflicts" : "clean",
    revisionId,
    tree: localTree,
    appliedPaths,
    noopPaths,
    conflicts,
  };
};

export const applyStellaSourcePack = (args: {
  pack: StellaSourcePack;
  localTree: StellaSourceTree;
  baseTree?: StellaSourceTree;
}): StellaSourceApplyResult =>
  applyStellaSourceChangeSetSequence({
    baseTree: args.baseTree ?? getStellaSourcePackBaseTree(args.pack),
    localTree: args.localTree,
    changeSets: args.pack.changeSets,
  });
