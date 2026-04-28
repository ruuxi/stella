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
  iconUrl?: string;
  authorDisplayName?: string;
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

const COMMENT_STRIP_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".sass",
  ".less", ".html", ".htm", ".vue", ".svelte", ".astro", ".java", ".kt",
  ".swift", ".php", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".py",
  ".rb", ".sh", ".bash", ".zsh", ".ps1", ".yml", ".yaml", ".toml", ".ini",
  ".conf",
]);

const getFileExtension = (filePath: string): string => {
  const fileName = normalizePath(filePath).split("/").pop() ?? filePath;
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
};

const shouldStripComments = (filePath: string): boolean =>
  COMMENT_STRIP_EXTENSIONS.has(getFileExtension(filePath));

const stripSlashComments = (input: string): string => {
  let output = "";
  let inBlockComment = false;
  let inString: "'" | "\"" | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += "\n";
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      inString = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      if (index < input.length) {
        output += "\n";
      }
      continue;
    }

    output += char;
  }

  return output;
};

const stripHashComments = (input: string): string =>
  input
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) return "";
      return line;
    })
    .join("\n");

const stripHtmlComments = (input: string): string =>
  input.replace(/<!--[\s\S]*?-->/g, "");

export const stripStoreCodeComments = (filePath: string, input: string): string => {
  if (!shouldStripComments(filePath)) {
    return input;
  }
  const ext = getFileExtension(filePath);
  let stripped = input;
  if ([".html", ".htm", ".vue", ".svelte", ".astro"].includes(ext)) {
    stripped = stripHtmlComments(stripped);
  }
  if ([".py", ".rb", ".sh", ".bash", ".zsh", ".ps1", ".yml", ".yaml", ".toml", ".ini", ".conf"].includes(ext)) {
    stripped = stripHashComments(stripped);
  }
  return stripSlashComments(stripped);
};

const decodeBase64ToText = (value: string): string => {
  const normalized = value.replace(/\s+/g, "");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

const encodeTextToBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
};

const stripPatchComments = (
  patch: string,
  files: string[],
): string => {
  const primaryPath = files.find(shouldStripComments);
  if (!primaryPath) {
    return patch;
  }
  return patch
    .split(/\r?\n/)
    .map((line) => {
      const prefix = line[0];
      if (
        (prefix !== "+" && prefix !== "-" && prefix !== " ") ||
        line.startsWith("+++") ||
        line.startsWith("---")
      ) {
        return line;
      }
      return `${prefix}${stripStoreCodeComments(primaryPath, line.slice(1))}`;
    })
    .join("\n");
};

const stripSnapshotContent = (
  filePath: string,
  contentBase64: string | undefined,
): string | undefined => {
  if (!contentBase64 || !shouldStripComments(filePath)) {
    return contentBase64;
  }
  return encodeTextToBase64(
    stripStoreCodeComments(filePath, decodeBase64ToText(contentBase64)),
  );
};

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
  iconUrl?: string;
  authorDisplayName?: string;
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
    body: "",
    patch: stripPatchComments(commit.patch, commit.files),
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
      ...(args.iconUrl ? { iconUrl: args.iconUrl } : {}),
      ...(args.authorDisplayName
        ? { authorDisplayName: args.authorDisplayName }
        : {}),
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
          ? {
              referenceContentBase64: stripSnapshotContent(
                filePath,
                snapshot.contentBase64,
              ),
            }
          : {}),
      };
    }),
  };
};
