import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";

export type SocialSessionWorkspaceFile = {
  relativePath: string;
  absolutePath: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
};

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "release",
]);

const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
]);

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export const normalizeSessionRelativePath = (value: string): string => {
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("relativePath is required.");
  }
  for (const segment of normalized) {
    if (segment === "." || segment === "..") {
      throw new Error("relativePath must stay inside the session workspace.");
    }
  }
  return normalized.join("/");
};

export const sanitizeSessionFolderLabel = (value: string): string => {
  const collapsed = value.trim().replace(/\s+/g, " ");
  const withoutInvalid = collapsed.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
  const trimmed = withoutInvalid.replace(/[. ]+$/g, "").slice(0, 80);
  const fallback = trimmed || "Stella Session";
  const baseName = fallback.toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(baseName) ? `${fallback}-session` : fallback;
};

export const resolveSessionLocalFolder = (
  sessionWorkspaceRoot: string,
  sessionId: string,
  folderLabel: string,
) => path.join(sessionWorkspaceRoot, `${sanitizeSessionFolderLabel(folderLabel)}-${sessionId.slice(0, 8)}`);

const shouldSkipDirectory = (name: string) =>
  IGNORED_DIR_NAMES.has(name)
  || name.startsWith(".stella-tmp");

const shouldSkipFile = (name: string) =>
  IGNORED_FILE_NAMES.has(name);

const hashFile = async (absolutePath: string) => {
  const data = await fs.readFile(absolutePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const walkWorkspace = async (
  rootPath: string,
  currentPath: string,
  results: SocialSessionWorkspaceFile[],
): Promise<void> => {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        return;
      }
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          return;
        }
        await walkWorkspace(rootPath, absolutePath, results);
        return;
      }
      if (!entry.isFile() || shouldSkipFile(entry.name)) {
        return;
      }
      const stat = await fs.stat(absolutePath);
      const relativePath = normalizeSessionRelativePath(path.relative(rootPath, absolutePath));
      results.push({
        relativePath,
        absolutePath,
        contentHash: await hashFile(absolutePath),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }),
  );
};

export const scanSessionWorkspace = async (
  rootPath: string,
): Promise<SocialSessionWorkspaceFile[]> => {
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const results: SocialSessionWorkspaceFile[] = [];
  await walkWorkspace(rootPath, rootPath, results);
  results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return results;
};

export const inferFileContentType = (relativePath: string): string => {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".ts":
    case ".tsx":
      return "text/plain";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
};

export const ensurePathWithinRoot = (
  rootPath: string,
  relativePath: string,
): string => {
  const normalizedRelativePath = normalizeSessionRelativePath(relativePath);
  const absoluteTarget = path.resolve(rootPath, normalizedRelativePath);
  const relativeToRoot = path.relative(rootPath, absoluteTarget);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Path escaped the session workspace root.");
  }
  return absoluteTarget;
};

export const applySessionFileOp = async (args: {
  rootPath: string;
  type: "upsert" | "delete" | "mkdir";
  relativePath: string;
  bytes?: Uint8Array;
}): Promise<void> => {
  const absoluteTarget = ensurePathWithinRoot(args.rootPath, args.relativePath);
  if (args.type === "delete") {
    await fs.rm(absoluteTarget, { recursive: true, force: true });
    return;
  }

  if (args.type === "mkdir") {
    await fs.mkdir(absoluteTarget, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
  await fs.writeFile(absoluteTarget, args.bytes ?? new Uint8Array());
};
