import { promises as fs } from "fs";
import os from "os";
import path from "path";
export const DEFERRED_DELETE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFERRED_DELETE_DIR = "deferred-delete";
const DEFERRED_DELETE_ITEMS_DIR = "items";
const DEFERRED_DELETE_TRASH_DIR = "trash";
const getStellaHome = (override) => {
    if (override && override.trim().length > 0) {
        return override;
    }
    const fromEnv = process.env.STELLA_HOME;
    if (fromEnv && fromEnv.trim().length > 0) {
        return fromEnv;
    }
    return path.join(os.homedir(), ".stella");
};
export const getDeferredDeletePaths = (stellaHomeOverride) => {
    const stellaHome = getStellaHome(stellaHomeOverride);
    const baseDir = path.join(stellaHome, "state", DEFERRED_DELETE_DIR);
    return {
        stellaHome,
        baseDir,
        itemsDir: path.join(baseDir, DEFERRED_DELETE_ITEMS_DIR),
        trashDir: path.join(baseDir, DEFERRED_DELETE_TRASH_DIR),
    };
};
const ensureDirectories = async (paths) => {
    await fs.mkdir(paths.itemsDir, { recursive: true });
    await fs.mkdir(paths.trashDir, { recursive: true });
};
const sanitizeBasename = (value) => value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
const isRootPath = (value) => {
    const resolved = path.resolve(value);
    return resolved === path.parse(resolved).root;
};
const isSubPath = (candidate, parentPath) => {
    const parent = path.resolve(parentPath);
    const target = path.resolve(candidate);
    return target === parent || target.startsWith(`${parent}${path.sep}`);
};
const normalizeTargetPath = (target, cwd) => path.resolve(cwd ?? process.cwd(), target);
const moveToTrash = async (sourcePath, trashPath) => {
    try {
        await fs.rename(sourcePath, trashPath);
        return;
    }
    catch (error) {
        const code = error.code;
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
export const trashPathsForDeferredDelete = async (targets, options) => {
    const result = { trashed: [], skipped: [], errors: [] };
    const paths = getDeferredDeletePaths(options.stellaHome);
    await ensureDirectories(paths);
    for (const rawTarget of targets) {
        const target = String(rawTarget ?? "").trim();
        if (!target) {
            continue;
        }
        const absoluteTarget = normalizeTargetPath(target, options.cwd);
        if (isRootPath(absoluteTarget)) {
            result.errors.push({
                path: absoluteTarget,
                error: "Refusing to delete filesystem root path.",
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
        }
        catch (error) {
            if (error.code === "ENOENT" && options.force) {
                result.skipped.push(absoluteTarget);
                continue;
            }
            result.errors.push({
                path: absoluteTarget,
                error: error.message,
            });
            continue;
        }
        const id = crypto.randomUUID();
        const trashedAt = Date.now();
        const basename = sanitizeBasename(path.basename(absoluteTarget));
        const trashPath = path.join(paths.trashDir, `${id}__${basename}`);
        const metadataPath = path.join(paths.itemsDir, `${id}.json`);
        const record = {
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
        }
        catch (error) {
            result.errors.push({
                path: absoluteTarget,
                error: error.message,
            });
        }
    }
    return result;
};
export const trashPathForDeferredDelete = async (target, options) => {
    const result = await trashPathsForDeferredDelete([target], options);
    if (result.errors.length > 0) {
        throw new Error(result.errors[0].error);
    }
    return result.trashed[0] ?? null;
};
const parseRecord = (raw) => {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed ||
            typeof parsed.id !== "string" ||
            typeof parsed.trashPath !== "string" ||
            typeof parsed.purgeAfter !== "number") {
            return null;
        }
        return {
            id: parsed.id,
            source: typeof parsed.source === "string" ? parsed.source : "unknown",
            originalPath: typeof parsed.originalPath === "string" ? parsed.originalPath : "",
            trashPath: parsed.trashPath,
            trashedAt: typeof parsed.trashedAt === "number" ? parsed.trashedAt : 0,
            purgeAfter: parsed.purgeAfter,
            requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
            agentType: typeof parsed.agentType === "string" ? parsed.agentType : undefined,
            conversationId: typeof parsed.conversationId === "string"
                ? parsed.conversationId
                : undefined,
        };
    }
    catch {
        return null;
    }
};
export const purgeExpiredDeferredDeletes = async (options) => {
    const now = options?.now ?? Date.now();
    const paths = getDeferredDeletePaths(options?.stellaHome);
    const summary = {
        checked: 0,
        purged: 0,
        skipped: 0,
        errors: [],
    };
    try {
        await fs.mkdir(paths.itemsDir, { recursive: true });
        await fs.mkdir(paths.trashDir, { recursive: true });
    }
    catch (error) {
        summary.errors.push(error.message);
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
            await fs.rm(metadataPath, { force: true }).catch(() => { });
            continue;
        }
        if (record.purgeAfter > now) {
            summary.skipped += 1;
            continue;
        }
        if (!isSubPath(record.trashPath, paths.trashDir)) {
            summary.errors.push(`Refusing to purge out-of-scope path for record ${record.id}: ${record.trashPath}`);
            continue;
        }
        try {
            await fs.rm(record.trashPath, { recursive: true, force: true });
            await fs.rm(metadataPath, { force: true });
            summary.purged += 1;
        }
        catch (error) {
            summary.errors.push(`Failed to purge ${record.trashPath}: ${error.message}`);
        }
    }
    return summary;
};
