/**
 * Atomic apply: staged changes -> source with rollback on failure.
 */
import { promises as fs } from "fs";
import path from "path";
import { clearStaging, listStagedFiles, readStaged } from "./staging.js";
import { updateFeature } from "./features.js";
import { takeSnapshot } from "./snapshots.js";
const FEATURES_ROOT_RELATIVE = ".stella/mods/features";
const TEMP_SUFFIX = ".stella_tmp_";
const BACKUP_SUFFIX = ".stella_bak_";
const pathExists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
};
const removeIfExists = async (filePath) => {
    try {
        await fs.rm(filePath, { force: true });
    }
    catch {
        // Best effort cleanup.
    }
};
const renameWithDir = async (fromPath, toPath) => {
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
};
async function readHistory(featureId) {
    const homedir = (await import("os")).homedir();
    const historyPath = path.join(homedir, FEATURES_ROOT_RELATIVE, featureId, "history.json");
    try {
        const raw = await fs.readFile(historyPath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
async function writeHistory(featureId, history) {
    const homedir = (await import("os")).homedir();
    const historyPath = path.join(homedir, FEATURES_ROOT_RELATIVE, featureId, "history.json");
    await fs.writeFile(historyPath, JSON.stringify(history, null, 2), "utf-8");
}
/**
 * Apply all staged files for a feature to the source directory.
 * 1. Snapshot current source versions (takeSnapshot)
 * 2. Materialize all staged files to temp files
 * 3. Move existing source files aside as backups
 * 4. Promote temp files into source paths
 * 5. Roll back fully if any step fails
 * 6. Record history + clear staging
 */
export async function applyBatch(featureId, frontendRoot, message) {
    const stagedFiles = await listStagedFiles(featureId);
    if (stagedFiles.length === 0) {
        return { batchIndex: -1, files: [], message: "No staged files to apply" };
    }
    const history = await readHistory(featureId);
    const batchIndex = history.length;
    // Snapshot current source files for explicit, user-visible revert points.
    await takeSnapshot(featureId, batchIndex, stagedFiles, frontendRoot);
    const applyId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const operations = [];
    try {
        // Phase 1: write staged content to temp files.
        for (const relativePath of stagedFiles) {
            const content = await readStaged(featureId, relativePath);
            if (content === null) {
                throw new Error(`Missing staged content for ${relativePath}`);
            }
            const sourcePath = path.join(frontendRoot, relativePath);
            const tempPath = `${sourcePath}${TEMP_SUFFIX}${applyId}`;
            const backupPath = `${sourcePath}${BACKUP_SUFFIX}${applyId}`;
            const hadSource = await pathExists(sourcePath);
            await fs.mkdir(path.dirname(sourcePath), { recursive: true });
            await fs.writeFile(tempPath, content, "utf-8");
            operations.push({
                relativePath,
                sourcePath,
                tempPath,
                backupPath,
                hadSource,
                backupCreated: false,
                installed: false,
            });
        }
        // Phase 2: move originals aside.
        for (const op of operations) {
            if (!op.hadSource)
                continue;
            await renameWithDir(op.sourcePath, op.backupPath);
            op.backupCreated = true;
        }
        // Phase 3: promote temp files.
        for (const op of operations) {
            await renameWithDir(op.tempPath, op.sourcePath);
            op.installed = true;
        }
        // Cleanup backups only after all files are installed.
        await Promise.all(operations
            .filter((op) => op.backupCreated)
            .map(async (op) => removeIfExists(op.backupPath)));
        await clearStaging(featureId);
        const entry = {
            batchIndex,
            message,
            files: stagedFiles,
            appliedAt: Date.now(),
        };
        history.push(entry);
        await writeHistory(featureId, history);
        await updateFeature(featureId, { status: "applied" });
        return {
            batchIndex,
            files: stagedFiles,
            message,
        };
    }
    catch (error) {
        // Roll back partial installs first.
        const rollbackErrors = [];
        for (const op of [...operations].reverse()) {
            if (!op.installed)
                continue;
            try {
                await removeIfExists(op.sourcePath);
            }
            catch (cleanupError) {
                rollbackErrors.push(`Failed removing partial ${op.relativePath}: ${cleanupError.message}`);
            }
        }
        // Restore backups next.
        for (const op of [...operations].reverse()) {
            if (!op.backupCreated)
                continue;
            try {
                await renameWithDir(op.backupPath, op.sourcePath);
            }
            catch (restoreError) {
                rollbackErrors.push(`Failed restoring backup ${op.relativePath}: ${restoreError.message}`);
            }
        }
        // Best-effort cleanup for temp/backup artifacts.
        await Promise.all(operations.flatMap((op) => [
            removeIfExists(op.tempPath),
            removeIfExists(op.backupPath),
        ]));
        const baseMessage = `Atomic apply failed: ${error.message}`;
        if (rollbackErrors.length > 0) {
            throw new Error(`${baseMessage}\nRollback issues:\n- ${rollbackErrors.join("\n- ")}`);
        }
        throw new Error(baseMessage);
    }
}
/**
 * Get the apply history for a feature.
 */
export async function getHistory(featureId) {
    return readHistory(featureId);
}
/**
 * Remove the latest N history entries after a revert operation.
 */
export async function removeLastHistoryEntries(featureId, count) {
    const history = await readHistory(featureId);
    const nextLength = Math.max(0, history.length - Math.max(0, count));
    const nextHistory = history.slice(0, nextLength);
    await writeHistory(featureId, nextHistory);
    return nextHistory;
}
