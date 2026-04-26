import { ConvexError } from "convex/values";

export type StorePackageCategory = "agents" | "stella";

export type StoreReleaseBlueprintBatch = {
  batchId: string;
  ordinal: number;
  commitHash: string;
  files: string[];
  subject: string;
  body: string;
  patch: string;
};

export type StoreReleaseBlueprintFile = {
  path: string;
  changeType: "create" | "update" | "delete";
  deleted?: boolean;
  referenceContentBase64?: string;
};

export type StoreReleaseManifest = {
  packageId: string;
  releaseNumber: number;
  category: StorePackageCategory;
  displayName: string;
  description: string;
  releaseNotes?: string;
  batchIds: string[];
  commitHashes: string[];
  files: string[];
  createdAt: number;
};

export type StoreReleaseArtifact = {
  kind: "self_mod_blueprint";
  schemaVersion: 1;
  manifest: StoreReleaseManifest;
  applyGuidance: string;
  batches: StoreReleaseBlueprintBatch[];
  files: StoreReleaseBlueprintFile[];
};

export type StorePublishCandidateFile = {
  path: string;
  deleted: boolean;
  contentBase64?: string;
};

export type StorePublishCandidateCommit = {
  commitHash: string;
  shortHash?: string;
  subject: string;
  body: string;
  timestampMs?: number;
  files: string[];
  patch: string;
  conversationId?: string;
};

export type StorePublishCandidateBundle = {
  requestText: string;
  selectedCommitHashes: string[];
  commits: StorePublishCandidateCommit[];
  files: StorePublishCandidateFile[];
  existingPackageId?: string;
};

export const STORE_PACKAGE_CATEGORIES = ["agents", "stella"] as const;

export const DEFAULT_BLUEPRINT_APPLY_GUIDANCE =
  "Treat this release blueprint as the reference implementation for the feature. " +
  "Stella installations can differ, so adapt the changes to the current local codebase instead of blindly copying text. " +
  "Create missing files when the blueprint expects them, update existing files to preserve the intended behavior, " +
  "and delete files only when the blueprint clearly marks them as removed.";

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, "/");

const normalizeFileList = (files: string[]): string[] =>
  Array.from(new Set(files.map(normalizePath).filter(Boolean))).sort();

export const isStorePackageCategory = (
  value: string,
): value is StorePackageCategory =>
  (STORE_PACKAGE_CATEGORIES as readonly string[]).includes(value);

export const normalizeStoreCategory = (
  value: string | undefined,
): StorePackageCategory => {
  const normalized = value?.trim().toLowerCase();
  return normalized && isStorePackageCategory(normalized)
    ? normalized
    : "stella";
};

const buildBlueprintFileChangeType = (args: {
  filePath: string;
  deleted: boolean;
  batches: StoreReleaseBlueprintBatch[];
}): StoreReleaseBlueprintFile["changeType"] => {
  if (args.deleted) {
    return "delete";
  }
  const normalizedPath = normalizePath(args.filePath);
  for (const batch of args.batches) {
    const normalizedPatch = batch.patch.replace(/\r\n/g, "\n");
    if (
      normalizedPatch.includes(`diff --git a/${normalizedPath} b/${normalizedPath}`) &&
      (normalizedPatch.includes("new file mode") ||
        normalizedPatch.includes(`--- /dev/null\n+++ b/${normalizedPath}`))
    ) {
      return "create";
    }
  }
  return "update";
};

export const buildStoreReleaseArtifactFromCandidate = (args: {
  packageId: string;
  releaseNumber: number;
  category: StorePackageCategory;
  displayName: string;
  description: string;
  releaseNotes?: string;
  candidate: StorePublishCandidateBundle;
}): StoreReleaseArtifact => {
  const selectedHashes = Array.from(
    new Set(args.candidate.selectedCommitHashes.map((hash) => hash.trim()).filter(Boolean)),
  );
  if (selectedHashes.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "At least one change must be selected to publish.",
    });
  }

  const commitsByHash = new Map(
    args.candidate.commits.map((commit) => [commit.commitHash.trim(), commit]),
  );
  const missing = selectedHashes.filter((hash) => !commitsByHash.has(hash));
  if (missing.length > 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Selected changes were missing from the candidate bundle: ${missing.join(", ")}`,
    });
  }

  const ordered = selectedHashes
    .map((hash) => commitsByHash.get(hash)!)
    .sort((left, right) => (left.timestampMs ?? 0) - (right.timestampMs ?? 0));

  const batches: StoreReleaseBlueprintBatch[] = ordered.map((commit, index) => ({
    batchId: `commit:${commit.commitHash.slice(0, 12)}`,
    ordinal: index + 1,
    commitHash: commit.commitHash,
    files: normalizeFileList(commit.files),
    subject: commit.subject,
    body: commit.body,
    patch: commit.patch,
  }));

  const files = normalizeFileList(batches.flatMap((batch) => batch.files));
  const candidateFiles = new Map(
    args.candidate.files.map((file) => [normalizePath(file.path), file]),
  );

  return {
    kind: "self_mod_blueprint",
    schemaVersion: 1,
    manifest: {
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      category: args.category,
      displayName: args.displayName,
      description: args.description,
      ...(args.releaseNotes ? { releaseNotes: args.releaseNotes } : {}),
      batchIds: batches.map((batch) => batch.batchId),
      commitHashes: ordered.map((commit) => commit.commitHash),
      files,
      createdAt: Date.now(),
    },
    applyGuidance: DEFAULT_BLUEPRINT_APPLY_GUIDANCE,
    batches,
    files: files.map((filePath) => {
      const snapshot = candidateFiles.get(filePath);
      const deleted = snapshot?.deleted ?? false;
      return {
        path: filePath,
        changeType: buildBlueprintFileChangeType({
          filePath,
          deleted,
          batches,
        }),
        ...(deleted ? { deleted: true } : {}),
        ...(snapshot?.contentBase64
          ? { referenceContentBase64: snapshot.contentBase64 }
          : {}),
      };
    }),
  };
};
