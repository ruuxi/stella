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

export type FeatureMeta = {
  id: string;
  name: string;
  description: string;
  conversationId: string;
  status: "active" | "applied" | "reverted" | "packaged";
  createdAt: number;
  updatedAt: number;
};

/**
 * Create a new feature with metadata.
 */
export async function createFeature(
  id: string,
  name: string,
  description: string,
  conversationId: string,
): Promise<FeatureMeta> {
  const featureDir = path.join(FEATURES_ROOT(), id);
  await fs.mkdir(featureDir, { recursive: true });

  const meta: FeatureMeta = {
    id,
    name,
    description,
    conversationId,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await fs.writeFile(
    path.join(featureDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );

  // Initialize empty history
  await fs.writeFile(
    path.join(featureDir, "history.json"),
    JSON.stringify([], null, 2),
    "utf-8",
  );

  return meta;
}

/**
 * Get feature metadata by ID.
 */
export async function getFeature(
  featureId: string,
): Promise<FeatureMeta | null> {
  try {
    const metaPath = path.join(FEATURES_ROOT(), featureId, "meta.json");
    const raw = await fs.readFile(metaPath, "utf-8");
    return JSON.parse(raw) as FeatureMeta;
  } catch {
    return null;
  }
}

/**
 * Update feature metadata.
 */
export async function updateFeature(
  featureId: string,
  updates: Partial<FeatureMeta>,
): Promise<void> {
  const meta = await getFeature(featureId);
  if (!meta) return;

  const updated = { ...meta, ...updates, updatedAt: Date.now() };
  const metaPath = path.join(FEATURES_ROOT(), featureId, "meta.json");
  await fs.writeFile(metaPath, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Get active feature for a conversation.
 */
export async function getActiveFeature(
  conversationId: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(ACTIVE_FILE(), "utf-8");
    const activeMap = JSON.parse(raw) as Record<string, string>;
    return activeMap[conversationId] ?? null;
  } catch {
    return null;
  }
}

/**
 * Set active feature for a conversation.
 */
export async function setActiveFeature(
  conversationId: string,
  featureId: string,
): Promise<void> {
  let activeMap: Record<string, string> = {};
  try {
    const raw = await fs.readFile(ACTIVE_FILE(), "utf-8");
    activeMap = JSON.parse(raw) as Record<string, string>;
  } catch {
    // File doesn't exist yet
  }

  activeMap[conversationId] = featureId;
  await fs.mkdir(path.dirname(ACTIVE_FILE()), { recursive: true });
  await fs.writeFile(
    ACTIVE_FILE(),
    JSON.stringify(activeMap, null, 2),
    "utf-8",
  );
}

/**
 * List all features with their metadata.
 */
export async function listFeatures(): Promise<FeatureMeta[]> {
  const featuresRoot = FEATURES_ROOT();
  try {
    await fs.access(featuresRoot);
  } catch {
    return [];
  }

  const entries = await fs.readdir(featuresRoot, { withFileTypes: true });
  const features: FeatureMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await getFeature(entry.name);
    if (meta) features.push(meta);
  }

  return features.sort((a, b) => b.updatedAt - a.updatedAt);
}
