import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { resolveStellaRoot } from "../home/stella-home.js";

export const DEFERRED_DELETE_RETENTION_MS = 24 * 60 * 60 * 1000;

const DEFERRED_DELETE_DIR = "deferred-delete";
const DEFERRED_DELETE_ITEMS_DIR = "items";
const DEFERRED_DELETE_TRASH_DIR = "trash";

export type DeferredDeleteRecord = {
  id: string;
  source: string;
  originalPath: string;
  trashPath: string;
  trashedAt: number;
  purgeAfter: number;
  requestId?: string;
  agentType?: string;
  conversationId?: string;
};

export type TrashPathsOptions = {
  source: string;
  cwd?: string;
  force?: boolean;
  stellaHome?: string;
  requestId?: string;
  agentType?: string;
  conversationId?: string;
};

export type TrashPathsResult = {
  trashed: DeferredDeleteRecord[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
};

export type DeferredDeleteSweepResult = {
  checked: number;
  purged: number;
  skipped: number;
  errors: string[];
};

type DeferredDeletePaths = {
  stellaHome: string;
  baseDir: string;
  itemsDir: string;
  trashDir: string;
};

const getStellaHome = (override?: string) => {
  if (override && override.trim().length > 0) {
    return override;
  }
  return resolveStellaRoot();
};

export const getDeferredDeletePaths = (
  stellaHomeOverride?: string,
): DeferredDeletePaths => {
  const stellaHome = getStellaHome(stellaHomeOverride);
  const baseDir = path.join(stellaHome, "state", DEFERRED_DELETE_DIR);
  return {
    stellaHome,
    baseDir,
    itemsDir: path.join(baseDir, DEFERRED_DELETE_ITEMS_DIR),
    trashDir: path.join(baseDir, DEFERRED_DELETE_TRASH_DIR),
  };
};

const ensureDirectories = async (paths: DeferredDeletePaths) => {
  await fs.mkdir(paths.itemsDir, { recursive: true });
  await fs.mkdir(paths.trashDir, { recursive: true });
};

const sanitizeBasename = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "item";

const isRootPath = (value: string) => {
  const resolved = path.resolve(value);
  return resolved === path.parse(resolved).root;
};

const isSubPath = (candidate: string, parentPath: string) => {
  const parent = path.resolve(parentPath);
  const target = path.resolve(candidate);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
};

const normalizeForComparison = (value: string, pathApi: path.PlatformPath) =>
  pathApi
    .resolve(value)
    .replace(/[\\/]+$/g, "")
    .replace(/\\/g, "/")
    .toLowerCase();

const isSameOrInsidePath = (
  candidate: string,
  protectedPath: string,
  pathApi: path.PlatformPath,
) => {
  const target = normalizeForComparison(candidate, pathApi);
  const parent = normalizeForComparison(protectedPath, pathApi);
  return target === parent || target.startsWith(`${parent}/`);
};

const getProtectedDeletePaths = (): Array<{
  path: string;
  mode: "exact" | "tree";
  label: string;
  pathApi: path.PlatformPath;
}> => {
  const home = os.homedir();
  const homeParent = home ? path.dirname(home) : "";
  const userProfile = process.env.USERPROFILE ?? "";
  const userProfileParent = userProfile ? path.win32.dirname(userProfile) : "";

  const protectedPaths: Array<{
    path: string;
    mode: "exact" | "tree";
    label: string;
    pathApi: path.PlatformPath;
  }> = [];

  const add = (
    protectedPath: string,
    mode: "exact" | "tree",
    label: string,
    pathApi: path.PlatformPath = path,
  ) => {
    if (!protectedPath.trim()) return;
    protectedPaths.push({ path: protectedPath, mode, label, pathApi });
  };

  add(home, "exact", "home directory");
  add(homeParent, "exact", "home parent directory");
  add(userProfile, "exact", "Windows user profile directory", path.win32);
  add(userProfileParent, "exact", "Windows users directory", path.win32);

  for (const protectedPath of [
    "/Applications",
    "/Library",
    "/System",
    "/Users",
    "/Volumes",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/private",
    "/proc",
    "/sbin",
    "/sys",
    "/usr",
    "/var",
  ]) {
    add(protectedPath, "exact", "system directory");
  }

  for (const protectedPath of [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "C:\\Users",
  ]) {
    add(protectedPath, "exact", "Windows system directory", path.win32);
  }

  return protectedPaths;
};

const getProtectedDeleteReason = (absoluteTarget: string): string | null => {
  if (isRootPath(absoluteTarget)) {
    return "Refusing to delete filesystem root path.";
  }

  for (const protectedPath of getProtectedDeletePaths()) {
    const matches =
      protectedPath.mode === "tree"
        ? isSameOrInsidePath(
            absoluteTarget,
            protectedPath.path,
            protectedPath.pathApi,
          )
        : normalizeForComparison(absoluteTarget, protectedPath.pathApi) ===
          normalizeForComparison(protectedPath.path, protectedPath.pathApi);
    if (matches) {
      return `Refusing to delete protected ${protectedPath.label}.`;
    }
  }

  return null;
};

const normalizeTargetPath = (target: string, cwd?: string) =>
  path.resolve(cwd ?? process.cwd(), target);

const moveToTrash = async (sourcePath: string, trashPath: string) => {
  try {
    await fs.rename(sourcePath, trashPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      throw error;
    }
  }

  await fs.cp(sourcePath, trashPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
  });
  await fs.rm(sourcePath, { recursive: true, force: true });
};

export const trashPathsForDeferredDelete = async (
  targets: string[],
  options: TrashPathsOptions,
): Promise<TrashPathsResult> => {
  const result: TrashPathsResult = { trashed: [], skipped: [], errors: [] };
  const paths = getDeferredDeletePaths(options.stellaHome);
  await ensureDirectories(paths);

  for (const rawTarget of targets) {
    const target = String(rawTarget ?? "").trim();
    if (!target) {
      continue;
    }

    const absoluteTarget = normalizeTargetPath(target, options.cwd);

    const protectedReason = getProtectedDeleteReason(absoluteTarget);
    if (protectedReason) {
      result.errors.push({
        path: absoluteTarget,
        error: protectedReason,
      });
      continue;
    }

    if (isSubPath(absoluteTarget, paths.baseDir)) {
      result.errors.push({
        path: absoluteTarget,
        error: "Refusing to delete Stella deferred-delete internals.",
      });
      continue;
    }

    try {
      await fs.lstat(absoluteTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.force) {
        result.skipped.push(absoluteTarget);
        continue;
      }
      result.errors.push({
        path: absoluteTarget,
        error: (error as Error).message,
      });
      continue;
    }

    const id = crypto.randomUUID();
    const trashedAt = Date.now();
    const basename = sanitizeBasename(path.basename(absoluteTarget));
    const trashPath = path.join(paths.trashDir, `${id}__${basename}`);
    const metadataPath = path.join(paths.itemsDir, `${id}.json`);

    const record: DeferredDeleteRecord = {
      id,
      source: options.source,
      originalPath: absoluteTarget,
      trashPath,
      trashedAt,
      purgeAfter: trashedAt + DEFERRED_DELETE_RETENTION_MS,
      requestId: options.requestId,
      agentType: options.agentType,
      conversationId: options.conversationId,
    };

    try {
      await moveToTrash(absoluteTarget, trashPath);
      await fs.writeFile(metadataPath, JSON.stringify(record, null, 2), "utf-8");
      result.trashed.push(record);
    } catch (error) {
      result.errors.push({
        path: absoluteTarget,
        error: (error as Error).message,
      });
    }
  }

  return result;
};

export const trashPathForDeferredDelete = async (
  target: string,
  options: TrashPathsOptions,
): Promise<DeferredDeleteRecord | null> => {
  const result = await trashPathsForDeferredDelete([target], options);
  if (result.errors.length > 0) {
    throw new Error(result.errors[0].error);
  }
  return result.trashed[0] ?? null;
};

const parseRecord = (raw: string): DeferredDeleteRecord | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<DeferredDeleteRecord>;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.trashPath !== "string" ||
      typeof parsed.purgeAfter !== "number"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      source: typeof parsed.source === "string" ? parsed.source : "unknown",
      originalPath: typeof parsed.originalPath === "string" ? parsed.originalPath : "",
      trashPath: parsed.trashPath,
      trashedAt: typeof parsed.trashedAt === "number" ? parsed.trashedAt : 0,
      purgeAfter: parsed.purgeAfter,
      requestId:
        typeof parsed.requestId === "string" ? parsed.requestId : undefined,
      agentType:
        typeof parsed.agentType === "string" ? parsed.agentType : undefined,
      conversationId:
        typeof parsed.conversationId === "string"
          ? parsed.conversationId
          : undefined,
    };
  } catch {
    return null;
  }
};

export const purgeExpiredDeferredDeletes = async (options?: {
  stellaHome?: string;
  now?: number;
}): Promise<DeferredDeleteSweepResult> => {
  const now = options?.now ?? Date.now();
  const paths = getDeferredDeletePaths(options?.stellaHome);
  const summary: DeferredDeleteSweepResult = {
    checked: 0,
    purged: 0,
    skipped: 0,
    errors: [],
  };

  try {
    await fs.mkdir(paths.itemsDir, { recursive: true });
    await fs.mkdir(paths.trashDir, { recursive: true });
  } catch (error) {
    summary.errors.push((error as Error).message);
    return summary;
  }

  const metadataFiles = await fs.readdir(paths.itemsDir).catch(() => []);
  for (const metadataFile of metadataFiles) {
    if (!metadataFile.endsWith(".json")) {
      continue;
    }

    summary.checked += 1;
    const metadataPath = path.join(paths.itemsDir, metadataFile);
    const raw = await fs.readFile(metadataPath, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }

    const record = parseRecord(raw);
    if (!record) {
      await fs.rm(metadataPath, { force: true }).catch(() => {});
      continue;
    }

    if (record.purgeAfter > now) {
      summary.skipped += 1;
      continue;
    }

    if (!isSubPath(record.trashPath, paths.trashDir)) {
      summary.errors.push(
        `Refusing to purge out-of-scope path for record ${record.id}: ${record.trashPath}`,
      );
      continue;
    }

    try {
      await fs.rm(record.trashPath, { recursive: true, force: true });
      await fs.rm(metadataPath, { force: true });
      summary.purged += 1;
    } catch (error) {
      summary.errors.push(
        `Failed to purge ${record.trashPath}: ${(error as Error).message}`,
      );
    }
  }

  return summary;
};
