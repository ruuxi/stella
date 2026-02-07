/**
 * Snapshot/revert system.
 * Before each apply, backup originals to ~/.stella/mods/features/{featureId}/snapshots/{batchIndex}/
 */

import { promises as fs } from "fs";
import path from "path";
import { getModsRoot } from "./staging.js";

const FEATURES_ROOT = () => path.join(getModsRoot(), "features");

export type SnapshotEntry = {
  batchIndex: number;
  files: string[];
  createdAt: number;
};

function snapshotsDir(featureId: string): string {
  return path.join(FEATURES_ROOT(), featureId, "snapshots");
}

function snapshotDir(featureId: string, batchIndex: number): string {
  return path.join(snapshotsDir(featureId), String(batchIndex));
}

/**
 * Take a snapshot of the current source files before applying changes.
 * Copies each file from frontendRoot + relativePath into the snapshot dir.
 */
export async function takeSnapshot(
  featureId: string,
  batchIndex: number,
  filePaths: string[],
  frontendRoot: string,
): Promise<void> {
  const dir = snapshotDir(featureId, batchIndex);
  await fs.mkdir(dir, { recursive: true });

  for (const relativePath of filePaths) {
    const sourcePath = path.join(frontendRoot, relativePath);
    const snapshotPath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });

    try {
      const content = await fs.readFile(sourcePath, "utf-8");
      await fs.writeFile(snapshotPath, content, "utf-8");
    } catch {
      // File doesn't exist yet (new file being created) — store a sentinel
      await fs.writeFile(
        snapshotPath + ".__new__",
        "",
        "utf-8",
      );
    }
  }
}

/**
 * Restore a snapshot, copying files back to source.
 * For files marked as __new__ (didn't exist before), delete them from source.
 */
export async function restoreSnapshot(
  featureId: string,
  batchIndex: number,
  frontendRoot: string,
): Promise<string[]> {
  const dir = snapshotDir(featureId, batchIndex);
  const restoredFiles: string[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      // Handle __new__ sentinel: delete the source file
      if (entry.name.endsWith(".__new__")) {
        const relativePath = path.relative(dir, fullPath.replace(".__new__", ""));
        const sourcePath = path.join(frontendRoot, relativePath);
        try {
          await fs.unlink(sourcePath);
        } catch {
          // Already gone
        }
        restoredFiles.push(relativePath);
        continue;
      }

      const relativePath = path.relative(dir, fullPath);
      const sourcePath = path.join(frontendRoot, relativePath);
      const content = await fs.readFile(fullPath, "utf-8");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, content, "utf-8");
      restoredFiles.push(relativePath);
    }
  }

  try {
    await walk(dir);
  } catch {
    // Snapshot dir doesn't exist
  }

  return restoredFiles;
}

/**
 * List available revert points for a feature.
 */
export async function listSnapshots(
  featureId: string,
): Promise<SnapshotEntry[]> {
  const dir = snapshotsDir(featureId);
  try {
    await fs.access(dir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const snapshots: SnapshotEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const batchIndex = Number(entry.name);
    if (Number.isNaN(batchIndex)) continue;

    const batchDir = path.join(dir, entry.name);
    const files: string[] = [];

    async function collectFiles(currentDir: string) {
      const subEntries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const subEntry of subEntries) {
        const fullPath = path.join(currentDir, subEntry.name);
        if (subEntry.isDirectory()) {
          await collectFiles(fullPath);
        } else if (!subEntry.name.endsWith(".__new__")) {
          files.push(path.relative(batchDir, fullPath));
        }
      }
    }

    await collectFiles(batchDir);

    const stat = await fs.stat(batchDir);
    snapshots.push({
      batchIndex,
      files,
      createdAt: stat.mtimeMs,
    });
  }

  return snapshots.sort((a, b) => a.batchIndex - b.batchIndex);
}
