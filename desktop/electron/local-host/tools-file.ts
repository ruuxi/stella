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
  setActiveFeature,
} from "../self-mod/index.js";

/** Options bag passed from tools.ts */
export type FileToolsConfig = {
  frontendRoot?: string;
};

let _config: FileToolsConfig = {};

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
 * Auto-creates one if needed.
 */
async function ensureActiveFeature(context: ToolContext): Promise<string> {
  let featureId = await getActiveFeature(context.conversationId);
  if (!featureId) {
    featureId = `mod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await createFeature(
      featureId,
      `Modification ${new Date().toLocaleString()}`,
      "Auto-created self-mod feature",
      context.conversationId,
    );
    await setActiveFeature(context.conversationId, featureId);
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
      const featureId = await ensureActiveFeature(context);
      await stageFile(featureId, relativePath, content);
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
      const featureId = await ensureActiveFeature(context);

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
