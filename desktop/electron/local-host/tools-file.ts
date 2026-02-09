/**
 * File tools: Read, Write, Edit handlers.
 * When the agent is self_mod and the file is within frontend/src/,
 * operations are redirected to the staging system.
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
import {
  stageFile,
  readStaged,
  getActiveFeature,
  createFeature,
  getFeature,
  getHistory,
  listStagedFiles,
  setActiveFeature,
  updateFeature,
} from "../self-mod/index.js";

/** Options bag passed from tools.ts */
export type FileToolsConfig = {
  frontendRoot?: string;
};

let _config: FileToolsConfig = {};

const FEATURE_IDLE_MS = 15 * 60 * 1000;
const FEATURE_TOPIC_SHIFT_MS = 90 * 1000;

export function setFileToolsConfig(config: FileToolsConfig) {
  _config = config;
}

/**
 * Check if a file path is within frontend/src/ and should be intercepted.
 * Returns the relative path (e.g., "src/components/Sidebar.tsx") or null.
 */
function getSrcRelativePath(filePath: string): string | null {
  if (!_config.frontendRoot) return null;
  const srcRoot = path.join(_config.frontendRoot, "src");
  const normalized = path.normalize(filePath);
  if (normalized.startsWith(srcRoot + path.sep) || normalized === srcRoot) {
    return path.relative(_config.frontendRoot, normalized);
  }
  return null;
}

/**
 * Ensure an active feature exists for the conversation.
 * Auto-creates one when needed and auto-groups related edits.
 */
const splitSegments = (value: string) =>
  value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

const normalizeTopic = (relativePath: string): string => {
  const segments = splitSegments(relativePath);
  const trimmed = segments[0] === "src" ? segments.slice(1) : segments;
  return trimmed.slice(0, 2).join("/");
};

const isRelatedPath = (targetPath: string, paths: string[]): boolean => {
  const targetTopic = normalizeTopic(targetPath);
  return paths.some((candidate) => normalizeTopic(candidate) === targetTopic);
};

const buildFeatureName = (relativePath: string): string => {
  const topic = normalizeTopic(relativePath);
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
  const topic = normalizeTopic(relativePath);
  await createFeature(
    featureId,
    buildFeatureName(relativePath),
    topic
      ? `Auto-created self-mod feature (${reason}) for ${topic}`
      : `Auto-created self-mod feature (${reason})`,
    context.conversationId,
  );
  await setActiveFeature(context.conversationId, featureId);
  return featureId;
};

async function ensureActiveFeature(
  context: ToolContext,
  relativePath: string,
): Promise<string> {
  const now = Date.now();
  const featureId = await getActiveFeature(context.conversationId);
  if (!featureId) {
    return createAndActivateFeature(context, relativePath, "no active feature");
  }

  const feature = await getFeature(featureId);
  if (!feature) {
    return createAndActivateFeature(context, relativePath, "missing feature metadata");
  }

  if (feature.status === "reverted" || feature.status === "packaged") {
    return createAndActivateFeature(context, relativePath, `status=${feature.status}`);
  }

  const stagedFiles = await listStagedFiles(featureId);
  if (stagedFiles.length > 0) {
    if (isRelatedPath(relativePath, stagedFiles)) {
      return featureId;
    }
    if (now - feature.updatedAt > FEATURE_TOPIC_SHIFT_MS) {
      return createAndActivateFeature(
        context,
        relativePath,
        "staged changes are from a different topic",
      );
    }
    return featureId;
  }

  const history = await getHistory(featureId);
  const lastBatchFiles = history.length > 0 ? history[history.length - 1].files : [];
  const idleForMs = now - feature.updatedAt;

  if (idleForMs > FEATURE_IDLE_MS) {
    return createAndActivateFeature(context, relativePath, "idle timeout");
  }

  if (
    lastBatchFiles.length > 0 &&
    !isRelatedPath(relativePath, lastBatchFiles) &&
    idleForMs > FEATURE_TOPIC_SHIFT_MS
  ) {
    return createAndActivateFeature(
      context,
      relativePath,
      "topic shift detected",
    );
  }

  return featureId;
}

export const handleRead = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

  // Self-mod intercept: check staging first
  if (context?.agentType === "self_mod") {
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

  // Self-mod intercept: redirect to staging
  if (context?.agentType === "self_mod") {
    const relativePath = getSrcRelativePath(filePath);
    if (relativePath) {
      const featureId = await ensureActiveFeature(context, relativePath);
      await stageFile(featureId, relativePath, content);
      await updateFeature(featureId, { status: "active" });
      const lines = content.split("\n").length;
      return {
        result: `Staged ${content.length} characters (${lines} lines) to ${filePath} [feature: ${featureId}]. Call SelfModApply to apply changes.`,
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

  // Self-mod intercept: check staging, apply edit, re-stage
  if (context?.agentType === "self_mod") {
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
        result: `Staged ${replaceAll ? occurrences : 1} replacement(s) in ${filePath} [feature: ${featureId}]. Call SelfModApply to apply changes.`,
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
