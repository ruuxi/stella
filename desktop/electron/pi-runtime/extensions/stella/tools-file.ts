/**
 * File tools: Read, Write, Edit handlers.
 * When any agent writes to frontend/src/, operations are
 * redirected to the staging system (path-based auto-staging).
 */

import { promises as fs } from "fs";
import path from "path";
import type { ToolContext, ToolResult } from "./tools-types.js";
import {
  ensureAbsolutePath,
  expandHomePath,
  readFileSafe,
  formatWithLineNumbers,
} from "./tools-utils.js";
import { isBlockedPath } from "./command-safety.js";
import {
  stageFile,
  readStaged,
  getActiveFeature,
  createFeature,
  getFeature,
  setActiveFeature,
  updateFeature,
} from "../../../self-mod/index.js";

/** Options bag passed from tools.ts */
export type FileToolsConfig = {
  frontendRoot?: string;
};

let _config: FileToolsConfig = {};

export function setFileToolsConfig(config: FileToolsConfig) {
  _config = config;
}

/**
 * Paths under src/ that should bypass staging and write directly to disk.
 * Dashboard page panels are generated content — staging adds unnecessary
 * complexity and failure modes for files that don't need revert support.
 */
const DIRECT_WRITE_PREFIXES = [
  "src/views/home/pages/",
];

/**
 * Check if a file path is within frontend/src/ and should be intercepted.
 * Returns the relative path (e.g., "src/components/Sidebar.tsx") or null.
 * Returns null for paths in DIRECT_WRITE_PREFIXES (bypasses staging).
 */
function getSrcRelativePath(filePath: string): string | null {
  if (!_config.frontendRoot) return null;
  const srcRoot = path.join(_config.frontendRoot, "src");
  const normalized = path.normalize(filePath);
  if (normalized.startsWith(srcRoot + path.sep) || normalized === srcRoot) {
    const relative = path.relative(_config.frontendRoot, normalized)
      .replace(/\\/g, "/");
    if (DIRECT_WRITE_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
      return null;
    }
    return relative;
  }
  return null;
}

/**
 * Ensure an active feature exists for the conversation.
 * Auto-creates one when needed and auto-groups related edits.
 */
const buildFeatureName = (relativePath: string): string => {
  const segments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const trimmed = segments[0] === "src" ? segments.slice(1) : segments;
  const topic = trimmed.slice(0, 2).join("/");
  if (!topic) {
    return `Modification ${new Date().toLocaleString()}`;
  }
  return `Update ${topic}`;
};

const createAndActivateFeature = async (
  context: ToolContext,
  relativePath: string,
  reason: string,
): Promise<string> => {
  const featureId = `mod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = buildFeatureName(relativePath);
  await createFeature(
    featureId,
    name,
    `Auto-created self-mod feature (${reason}): ${name}`,
    context.conversationId,
  );
  await setActiveFeature(context.conversationId, featureId);
  return featureId;
};

async function ensureActiveFeature(
  context: ToolContext,
  relativePath: string,
): Promise<string> {
  const featureId = await getActiveFeature(context.conversationId);
  if (!featureId) {
    return createAndActivateFeature(context, relativePath, "no active feature");
  }

  const feature = await getFeature(featureId);
  if (!feature) {
    return createAndActivateFeature(context, relativePath, "missing feature metadata");
  }

  // Terminal statuses → start a new feature
  if (feature.status === "applied" || feature.status === "reverted" || feature.status === "packaged") {
    return createAndActivateFeature(context, relativePath, `status=${feature.status}`);
  }

  // Active feature → reuse (same response, still staging)
  return featureId;
}

export const handleRead = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

  // Safety check: block system directories
  const pathBlock = isBlockedPath(filePath);
  if (pathBlock) return { error: pathBlock };

  // Auto-staging intercept: check staging first for frontend/src/ paths
  if (context) {
    const relativePath = getSrcRelativePath(filePath);
    if (relativePath) {
      const featureId = await getActiveFeature(context.conversationId);
      if (featureId) {
        const staged = await readStaged(featureId, relativePath);
        if (staged !== null) {
          const offset = Number(args.offset ?? 1);
          const limit = Number(args.limit ?? 2000);
          const formatted = formatWithLineNumbers(staged, offset, limit);
          return {
            result: `File: ${filePath} (staged)\n${formatted.header}\n\n${formatted.body}`,
          };
        }
      }
    }
  }

  try {
    await fs.access(filePath);
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  const offset = Number(args.offset ?? 1);
  const limit = Number(args.limit ?? 2000);

  try {
    const read = await readFileSafe(filePath);
    if (!read.ok) return { error: read.error };
    const formatted = formatWithLineNumbers(read.content, offset, limit);
    return {
      result: `File: ${filePath}\n${formatted.header}\n\n${formatted.body}`,
    };
  } catch (error) {
    return { error: `Error reading file: ${(error as Error).message}` };
  }
};

export const handleWrite = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const content = String(args.content ?? "");
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

  // Safety check: block system directories
  const pathBlock = isBlockedPath(filePath);
  if (pathBlock) return { error: pathBlock };

  // Auto-staging intercept: redirect writes to frontend/src/ to staging
  if (context) {
    const relativePath = getSrcRelativePath(filePath);
    if (relativePath) {
      const featureId = await ensureActiveFeature(context, relativePath);
      await stageFile(featureId, relativePath, content);
      await updateFeature(featureId, { status: "active" });
      const lines = content.split("\n").length;
      return {
        result: `Staged ${content.length} characters (${lines} lines) to ${filePath} [feature: ${featureId}].`,
      };
    }
  }

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    const lines = content.split("\n").length;
    return {
      result: `Wrote ${content.length} characters (${lines} lines) to ${filePath}`,
    };
  } catch (error) {
    return { error: `Error writing file: ${(error as Error).message}` };
  }
};

export const handleEdit = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all ?? false);
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

  // Safety check: block system directories
  const pathBlock = isBlockedPath(filePath);
  if (pathBlock) return { error: pathBlock };

  // Auto-staging intercept: check staging, apply edit, re-stage for frontend/src/ paths
  if (context) {
    const relativePath = getSrcRelativePath(filePath);
    if (relativePath) {
      const featureId = await ensureActiveFeature(context, relativePath);

      // Try to read from staging first, fall back to source
      let content = await readStaged(featureId, relativePath);
      if (content === null) {
        try {
          content = await fs.readFile(filePath, "utf-8");
        } catch (error) {
          return {
            error: `Error reading file: ${(error as Error).message}`,
          };
        }
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return { error: "old_string not found in file." };
      }
      if (!replaceAll && occurrences > 1) {
        return {
          error: `old_string appears ${occurrences} times. Provide more context or set replace_all=true.`,
        };
      }

      const next = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      await stageFile(featureId, relativePath, next);
      await updateFeature(featureId, { status: "active" });
      return {
        result: `Staged ${replaceAll ? occurrences : 1} replacement(s) in ${filePath} [feature: ${featureId}].`,
      };
    }
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return { error: `Error reading file: ${(error as Error).message}` };
  }

  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return { error: "old_string not found in file." };
  }
  if (!replaceAll && occurrences > 1) {
    return {
      error: `old_string appears ${occurrences} times. Provide more context or set replace_all=true.`,
    };
  }

  const next = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  try {
    await fs.writeFile(filePath, next, "utf-8");
    return {
      result: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}`,
    };
  } catch (error) {
    return { error: `Error writing file: ${(error as Error).message}` };
  }
};
