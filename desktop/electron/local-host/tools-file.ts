/**
 * File tools: Read, Write, Edit handlers.
 */

import { promises as fs } from "fs";
import path from "path";
import type { ToolResult } from "./tools-types.js";
import {
  ensureAbsolutePath,
  expandHomePath,
  readFileSafe,
  formatWithLineNumbers,
} from "./tools-utils.js";

export const handleRead = async (args: Record<string, unknown>): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

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

export const handleWrite = async (args: Record<string, unknown>): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const content = String(args.content ?? "");
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

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

export const handleEdit = async (args: Record<string, unknown>): Promise<ToolResult> => {
  const filePath = expandHomePath(String(args.file_path ?? ""));
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all ?? false);
  const pathCheck = ensureAbsolutePath(filePath);
  if (!pathCheck.ok) return { error: pathCheck.error };

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
