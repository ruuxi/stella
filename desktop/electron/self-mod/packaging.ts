/**
 * Export/import mod packages.
 */

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { getFeature, listFeatures } from "./features.js";
import { getHistory } from "./apply.js";

export type ModFileEntry = {
  path: string;
  action: "modify" | "create";
  content: string;
  originalHash?: string;
};

export type ModPackage = {
  format: "stella-mod-v1";
  name: string;
  description: string;
  version: string;
  author?: { id: string; name: string };
  featureId: string;
  files: ModFileEntry[];
  createdAt: number;
};

export type ConflictInfo = {
  path: string;
  incomingMod: string;
  existingFeatures: string[];
};

export type ConflictReport = {
  hasConflicts: boolean;
  conflicts: ConflictInfo[];
};

/**
 * Package a feature into a mod package JSON.
 * Collects all files from the feature's history and reads their current content.
 */
export async function packageFeature(
  featureId: string,
  frontendRoot: string,
): Promise<ModPackage | null> {
  const meta = await getFeature(featureId);
  if (!meta) return null;

  const history = await getHistory(featureId);

  // Collect unique file paths from all batches
  const allFiles = new Set<string>();
  for (const entry of history) {
    for (const file of entry.files) {
      allFiles.add(file);
    }
  }

  // Read current content and compute hashes
  const files: ModFileEntry[] = [];
  for (const filePath of allFiles) {
    const sourcePath = path.join(frontendRoot, filePath);
    try {
      const content = await fs.readFile(sourcePath, "utf-8");
      const hash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      // Check if this file existed before any batch by looking at the first snapshot
      let action: "modify" | "create" = "modify";
      if (history.length > 0) {
        const firstBatch = history[0];
        if (firstBatch.files.includes(filePath)) {
          // Check if original snapshot exists for this file
          const os = await import("os");
          const snapshotPath = path.join(
            os.homedir(),
            ".stella",
            "mods",
            "features",
            featureId,
            "snapshots",
            "0",
            filePath,
          );
          try {
            await fs.access(snapshotPath + ".__new__");
            action = "create";
          } catch {
            // Original existed, it's a modify
          }
        }
      }

      files.push({
        path: filePath,
        action,
        content,
        originalHash: `sha256-${hash}`,
      });
    } catch {
      // File may have been deleted
    }
  }

  return {
    format: "stella-mod-v1",
    name: meta.name,
    description: meta.description,
    version: "1.0.0",
    featureId,
    files,
    createdAt: Date.now(),
  };
}

/**
 * Install a mod package to the local source.
 */
export async function installMod(
  modPackage: ModPackage,
  frontendRoot: string,
): Promise<{ installed: string[] }> {
  const installed: string[] = [];

  for (const file of modPackage.files) {
    const targetPath = path.join(frontendRoot, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf-8");
    installed.push(file.path);
  }

  return { installed };
}

/**
 * Detect conflicts between an incoming mod and active features.
 */
export async function detectConflicts(
  modPackage: ModPackage,
): Promise<ConflictReport> {
  const features = await listFeatures();
  const activeFeatures = features.filter(
    (f) => f.status === "active" || f.status === "applied",
  );

  // Build a map of file → owning features
  const fileOwners = new Map<string, string[]>();
  for (const feature of activeFeatures) {
    const history = await getHistory(feature.id);
    for (const entry of history) {
      for (const file of entry.files) {
        const owners = fileOwners.get(file) ?? [];
        if (!owners.includes(feature.name)) {
          owners.push(feature.name);
        }
        fileOwners.set(file, owners);
      }
    }
  }

  // Check incoming mod files against existing features
  const conflicts: ConflictInfo[] = [];
  for (const file of modPackage.files) {
    const owners = fileOwners.get(file.path);
    if (owners && owners.length > 0) {
      conflicts.push({
        path: file.path,
        incomingMod: modPackage.name,
        existingFeatures: owners,
      });
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Install a mod with conflict checking.
 * Returns either a success result or a conflict report for agent-mediated resolution.
 */
export async function installModWithConflictCheck(
  modPackage: ModPackage,
  frontendRoot: string,
): Promise<
  | { ok: true; installed: string[] }
  | { ok: false; conflicts: ConflictReport }
> {
  const report = await detectConflicts(modPackage);
  if (report.hasConflicts) {
    return { ok: false, conflicts: report };
  }
  const result = await installMod(modPackage, frontendRoot);
  return { ok: true, installed: result.installed };
}
