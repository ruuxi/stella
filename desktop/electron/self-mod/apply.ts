/**
 * Atomic apply: stages → source, with snapshot backup.
 */

import { promises as fs } from "fs";
import path from "path";
import { listStagedFiles, readStaged, clearStaging } from "./staging.js";
import { getFeature, updateFeature } from "./features.js";
import { takeSnapshot } from "./snapshots.js";

const FEATURES_ROOT_RELATIVE = ".stella/mods/features";

export type BatchResult = {
  batchIndex: number;
  files: string[];
  message?: string;
};

export type HistoryEntry = {
  batchIndex: number;
  message?: string;
  files: string[];
  appliedAt: number;
};

async function readHistory(featureId: string): Promise<HistoryEntry[]> {
  const homedir = (await import("os")).homedir();
  const historyPath = path.join(
    homedir,
    FEATURES_ROOT_RELATIVE,
    featureId,
    "history.json",
  );
  try {
    const raw = await fs.readFile(historyPath, "utf-8");
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

async function writeHistory(
  featureId: string,
  history: HistoryEntry[],
): Promise<void> {
  const homedir = (await import("os")).homedir();
  const historyPath = path.join(
    homedir,
    FEATURES_ROOT_RELATIVE,
    featureId,
    "history.json",
  );
  await fs.writeFile(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Apply all staged files for a feature to the source directory.
 * 1. List staged files
 * 2. Backup current source versions (takeSnapshot)
 * 3. Write all staged files to source
 * 4. Clear staging
 * 5. Record in history
 */
export async function applyBatch(
  featureId: string,
  frontendRoot: string,
  message?: string,
): Promise<BatchResult> {
  const stagedFiles = await listStagedFiles(featureId);
  if (stagedFiles.length === 0) {
    return { batchIndex: -1, files: [], message: "No staged files to apply" };
  }

  // Determine batch index
  const history = await readHistory(featureId);
  const batchIndex = history.length;

  // Snapshot current source files
  await takeSnapshot(featureId, batchIndex, stagedFiles, frontendRoot);

  // Apply all staged files to source (tight loop for HMR batching)
  for (const relativePath of stagedFiles) {
    const content = await readStaged(featureId, relativePath);
    if (content === null) continue;

    const sourcePath = path.join(frontendRoot, relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content, "utf-8");
  }

  // Clear staging
  await clearStaging(featureId);

  // Record in history
  const entry: HistoryEntry = {
    batchIndex,
    message,
    files: stagedFiles,
    appliedAt: Date.now(),
  };
  history.push(entry);
  await writeHistory(featureId, history);

  // Update feature metadata
  await updateFeature(featureId, { status: "applied" });

  return {
    batchIndex,
    files: stagedFiles,
    message,
  };
}

/**
 * Get the apply history for a feature.
 */
export async function getHistory(featureId: string): Promise<HistoryEntry[]> {
  return readHistory(featureId);
}
