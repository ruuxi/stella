/**
 * Feature lifecycle management.
 * Feature metadata stored at ~/.stella/mods/features/{featureId}/meta.json
 * Active feature tracking stored at ~/.stella/mods/active.json
 */
import { promises as fs } from "fs";
import path from "path";
import { getModsRoot } from "./staging.js";
const FEATURES_ROOT = () => path.join(getModsRoot(), "features");
const ACTIVE_FILE = () => path.join(getModsRoot(), "active.json");
/**
 * Create a new feature with metadata.
 */
export async function createFeature(id, name, description, conversationId) {
    const featureDir = path.join(FEATURES_ROOT(), id);
    await fs.mkdir(featureDir, { recursive: true });
    const meta = {
        id,
        name,
        description,
        conversationId,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await fs.writeFile(path.join(featureDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
    // Initialize empty history
    await fs.writeFile(path.join(featureDir, "history.json"), JSON.stringify([], null, 2), "utf-8");
    return meta;
}
/**
 * Get feature metadata by ID.
 */
export async function getFeature(featureId) {
    try {
        const metaPath = path.join(FEATURES_ROOT(), featureId, "meta.json");
        const raw = await fs.readFile(metaPath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Update feature metadata.
 */
export async function updateFeature(featureId, updates) {
    const meta = await getFeature(featureId);
    if (!meta)
        return;
    const updated = { ...meta, ...updates, updatedAt: Date.now() };
    const metaPath = path.join(FEATURES_ROOT(), featureId, "meta.json");
    await fs.writeFile(metaPath, JSON.stringify(updated, null, 2), "utf-8");
}
/**
 * Get active feature for a conversation.
 */
export async function getActiveFeature(conversationId) {
    try {
        const raw = await fs.readFile(ACTIVE_FILE(), "utf-8");
        const activeMap = JSON.parse(raw);
        return activeMap[conversationId] ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Set active feature for a conversation.
 */
export async function setActiveFeature(conversationId, featureId) {
    let activeMap = {};
    try {
        const raw = await fs.readFile(ACTIVE_FILE(), "utf-8");
        activeMap = JSON.parse(raw);
    }
    catch {
        // File doesn't exist yet
    }
    activeMap[conversationId] = featureId;
    await fs.mkdir(path.dirname(ACTIVE_FILE()), { recursive: true });
    await fs.writeFile(ACTIVE_FILE(), JSON.stringify(activeMap, null, 2), "utf-8");
}
/**
 * List all features with their metadata.
 */
export async function listFeatures() {
    const featuresRoot = FEATURES_ROOT();
    try {
        await fs.access(featuresRoot);
    }
    catch {
        return [];
    }
    const entries = await fs.readdir(featuresRoot, { withFileTypes: true });
    const features = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const meta = await getFeature(entry.name);
        if (meta)
            features.push(meta);
    }
    return features.sort((a, b) => b.updatedAt - a.updatedAt);
}
