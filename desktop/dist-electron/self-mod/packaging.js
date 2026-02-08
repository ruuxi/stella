/**
 * Blueprint packaging for self-mod features.
 *
 * Blueprints are reference code + description that another AI can use
 * to re-implement a feature fresh for their specific codebase state.
 */
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { getFeature } from "./features.js";
import { getHistory } from "./apply.js";
/**
 * Package a feature into a blueprint.
 * Collects all files from the feature's history and reads their current content.
 * The description and implementation fields are empty — the self-mod agent fills them in.
 */
export async function packageFeature(featureId, frontendRoot) {
    const meta = await getFeature(featureId);
    if (!meta)
        return null;
    const history = await getHistory(featureId);
    // Collect unique file paths from all batches
    const allFiles = new Set();
    for (const entry of history) {
        for (const file of entry.files) {
            allFiles.add(file);
        }
    }
    // Read current content and compute hashes
    const referenceFiles = [];
    for (const filePath of allFiles) {
        const sourcePath = path.join(frontendRoot, filePath);
        try {
            const content = await fs.readFile(sourcePath, "utf-8");
            const hash = crypto
                .createHash("sha256")
                .update(content)
                .digest("hex");
            // Check if this file existed before any batch by looking at the first snapshot
            let action = "modify";
            if (history.length > 0) {
                const firstBatch = history[0];
                if (firstBatch.files.includes(filePath)) {
                    // Check if original snapshot exists for this file
                    const os = await import("os");
                    const snapshotPath = path.join(os.homedir(), ".stella", "mods", "features", featureId, "snapshots", "0", filePath);
                    try {
                        await fs.access(snapshotPath + ".__new__");
                        action = "create";
                    }
                    catch {
                        // Original existed, it's a modify
                    }
                }
            }
            referenceFiles.push({
                path: filePath,
                action,
                content,
                originalHash: `sha256-${hash}`,
            });
        }
        catch {
            // File may have been deleted
        }
    }
    return {
        format: "stella-blueprint-v1",
        name: meta.name,
        description: "",
        implementation: "",
        version: "1.0.0",
        featureId,
        referenceFiles,
        createdAt: Date.now(),
    };
}
