/**
 * File tools: Read, Edit handlers.
 * Self-mod writes are direct filesystem writes; no staging interception.
 */

import { promises as fs } from "fs";
import type { ToolContext, ToolResult } from "./types.js";
import {
  ensureAbsolutePath,
  expandHomePath,
  readFileSafe,
  formatWithLineNumbers,
  detectLineEnding,
  fuzzyFindText,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./utils.js";
import { isBlockedPath } from "./command-safety.js";

export type FileToolsConfig = {
  frontendRoot?: string;
};

export function setFileToolsConfig(_config: FileToolsConfig) {
  // Intentionally no-op.
}

export const handleRead = async (
  args: Record<string, unknown>,
  _context?: ToolContext,
): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

  const pathBlock = isBlockedPath(filePath);
  if (pathBlock) return { error: pathBlock };

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

export const handleEdit = async (
  args: Record<string, unknown>,
  _context?: ToolContext,
): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all ?? false);
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

  const pathBlock = isBlockedPath(filePath);
  if (pathBlock) return { error: pathBlock };

  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return { error: `Error reading file: ${(error as Error).message}` };
  }

  // Use the shared Stella edit utilities for robust line ending handling,
  // BOM stripping, and fuzzy matching.
  const { bom, text: content } = stripBom(rawContent);
  const originalEnding = detectLineEnding(content);
  const normalizedContent = normalizeToLF(content);
  const normalizedOld = normalizeToLF(oldString);
  const normalizedNew = normalizeToLF(newString);

  if (replaceAll) {
    const occurrences = normalizedContent.split(normalizedOld).length - 1;
    if (occurrences === 0) {
      return { error: "old_string not found in file." };
    }
    const replaced = normalizedContent.split(normalizedOld).join(normalizedNew);
    const final = bom + restoreLineEndings(replaced, originalEnding);
    try {
      await fs.writeFile(filePath, final, "utf-8");
      return { result: `Replaced ${occurrences} occurrence(s) in ${filePath}` };
    } catch (error) {
      return { error: `Error writing file: ${(error as Error).message}` };
    }
  }

  // Single replacement with fuzzy matching
  const matchResult = fuzzyFindText(normalizedContent, normalizedOld);
  if (!matchResult.found) {
    return { error: "old_string not found in file." };
  }

  const baseContent = matchResult.contentForReplacement;
  const replaced =
    baseContent.substring(0, matchResult.index) +
    normalizedNew +
    baseContent.substring(matchResult.index + matchResult.matchLength);

  if (baseContent === replaced) {
    return { error: "old_string and new_string are identical — no changes made." };
  }

  const final = bom + restoreLineEndings(replaced, originalEnding);
  try {
    await fs.writeFile(filePath, final, "utf-8");
    return { result: `Replaced 1 occurrence(s) in ${filePath}` };
  } catch (error) {
    return { error: `Error writing file: ${(error as Error).message}` };
  }
};
