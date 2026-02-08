/**
 * Staging directory management.
 * All staged files live under ~/.stella/mods/staging/{featureId}/
 * mirroring the frontend/src/ structure.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
const MODS_ROOT = path.join(os.homedir(), ".stella", "mods");
const STAGING_ROOT = path.join(MODS_ROOT, "staging");
export const getStagingRoot = () => STAGING_ROOT;
export const getModsRoot = () => MODS_ROOT;
/**
 * Write a file to the staging directory for a feature.
 * relativePath should be relative to frontend/src/ (e.g., "components/Sidebar.tsx")
 */
export async function stageFile(featureId, relativePath, content) {
    const stagingPath = path.join(STAGING_ROOT, featureId, relativePath);
    await fs.mkdir(path.dirname(stagingPath), { recursive: true });
    await fs.writeFile(stagingPath, content, "utf-8");
}
/**
 * Read a staged file. Returns null if not staged.
 */
export async function readStaged(featureId, relativePath) {
    const stagingPath = path.join(STAGING_ROOT, featureId, relativePath);
    try {
        return await fs.readFile(stagingPath, "utf-8");
    }
    catch {
        return null;
    }
}
/**
 * List all staged files for a feature, returned as relative paths.
 */
export async function listStagedFiles(featureId) {
    const featureDir = path.join(STAGING_ROOT, featureId);
    try {
        await fs.access(featureDir);
    }
    catch {
        return [];
    }
    const files = [];
    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            }
            else {
                files.push(path.relative(featureDir, fullPath));
            }
        }
    }
    await walk(featureDir);
    return files;
}
/**
 * Remove staging directory for a feature.
 */
export async function clearStaging(featureId) {
    const featureDir = path.join(STAGING_ROOT, featureId);
    try {
        await fs.rm(featureDir, { recursive: true, force: true });
    }
    catch {
        // Already cleaned or doesn't exist
    }
}
