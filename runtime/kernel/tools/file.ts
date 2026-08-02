/**
 * File tools: Read, Write, Edit handlers.
 * Self-mod writes are direct filesystem writes; no staging interception.
 */

import { promises as fs } from "fs";
import path from "path";
import { Buffer } from "node:buffer";
import type { ToolContext, ToolResult } from "./types.js";
import { fileChange } from "../../contracts/file-changes.js";
import {
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
import { sanitizeToolVisibleText } from "./safety.js";
import { withFileWriteLock, writeFileWithNulGuard } from "./file-write-lock.js";
import { resolveImageMimeType } from "../shared/image-mime.js";

const isPathInsideRoot = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const requireAbsoluteFilePath = (rawPath: unknown): string => {
  const raw = String(rawPath ?? "");
  const expandedPath = expandHomePath(raw);
  if (!path.isAbsolute(expandedPath)) {
    throw new Error(
      `File tool paths must be absolute. Received relative path '${raw}'. ` +
        `Pass a full absolute path (e.g. /Users/you/projects/foo/bar.ts); ` +
        `the file tools do not resolve relative to the shell's working directory.`,
    );
  }
  return path.resolve(expandedPath);
};

export const resolveFilePath = (
  rawPath: unknown,
  context?: ToolContext,
): string => {
  const resolvedPath = requireAbsoluteFilePath(rawPath);
  const scopedRoot = context?.toolWorkspaceRoot?.trim()
    ? path.resolve(context.toolWorkspaceRoot)
    : null;

  if (scopedRoot && !isPathInsideRoot(resolvedPath, scopedRoot)) {
    throw new Error("Path is outside the shared session workspace.");
  }

  return resolvedPath;
};

export const readTextFile = async (
  rawPath: unknown,
  context?: ToolContext,
): Promise<{ path: string; content: string }> => {
  const filePath = resolveFilePath(rawPath, context);
  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const read = await readFileSafe(filePath);
  if (!read.ok) {
    throw new Error(read.error);
  }

  return { path: filePath, content: read.content };
};

export const writeTextFile = async (
  rawPath: unknown,
  content: string,
  context?: ToolContext,
): Promise<{ path: string; created: boolean }> => {
  const filePath = resolveFilePath(rawPath, context);
  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  // The whole read-current-state → write cycle runs under the per-path lock
  // so parallel Write/Edit calls against the same file cannot interleave.
  return withFileWriteLock(filePath, async () => {
    let existed = false;
    let originalEnding: "\r\n" | "\n" = "\n";

    try {
      const rawContent = await fs.readFile(filePath, "utf-8");
      existed = true;
      const { text } = stripBom(rawContent);
      originalEnding = detectLineEnding(text);
    } catch {
      existed = false;
    }

    const normalizedContent = normalizeToLF(content);
    const finalContent = existed
      ? restoreLineEndings(normalizedContent, originalEnding)
      : content;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileWithNulGuard(filePath, finalContent);

    return { path: filePath, created: !existed };
  });
};

export const replaceTextInFile = async (
  args: {
    filePath: unknown;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  },
  context?: ToolContext,
): Promise<{ path: string; replacements: number }> => {
  const filePath = resolveFilePath(args.filePath, context);
  const replaceAll = Boolean(args.replaceAll ?? false);

  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  // Read → apply → write must be atomic relative to sibling edits of the
  // same file: parallel tool calls otherwise clobber each other's hunks.
  return withFileWriteLock(filePath, async () => {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      throw new Error(`Error reading file: ${(error as Error).message}`);
    }

    const { bom, text: content } = stripBom(rawContent);
    const originalEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLF(content);
    const normalizedOld = normalizeToLF(args.oldString);
    const normalizedNew = normalizeToLF(args.newString);

    if (replaceAll) {
      const occurrences = normalizedContent.split(normalizedOld).length - 1;
      if (occurrences === 0) {
        throw new Error("old_string not found in file.");
      }
      const replaced = normalizedContent
        .split(normalizedOld)
        .join(normalizedNew);
      const final = bom + restoreLineEndings(replaced, originalEnding);
      await writeFileWithNulGuard(filePath, final);
      return { path: filePath, replacements: occurrences };
    }

    const matchResult = fuzzyFindText(normalizedContent, normalizedOld);
    if (!matchResult.found) {
      throw new Error("old_string not found in file.");
    }

    const baseContent = matchResult.contentForReplacement;
    const replaced =
      baseContent.substring(0, matchResult.index) +
      normalizedNew +
      baseContent.substring(matchResult.index + matchResult.matchLength);

    if (baseContent === replaced) {
      throw new Error(
        "old_string and new_string are identical — no changes made.",
      );
    }

    const final = bom + restoreLineEndings(replaced, originalEnding);
    await writeFileWithNulGuard(filePath, final);

    return { path: filePath, replacements: 1 };
  });
};

export const handleRead = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  try {
    const filePath = resolveFilePath(args.file_path, context);
    const pathBlock = isBlockedPath(filePath, context);
    if (pathBlock) {
      throw new Error(pathBlock);
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }
    const file = await fs.open(filePath, "r");
    let header: Buffer;
    try {
      header = Buffer.alloc(12);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    const imageMimeType = resolveImageMimeType(filePath, header);
    if (imageMimeType) {
      return {
        result: `[stella-attach-image] inline=${imageMimeType} ${filePath}`,
        details: { path: filePath, mimeType: imageMimeType },
      };
    }

    const { path: textFilePath, content } = await readTextFile(
      args.file_path,
      context,
    );
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? 2000);
    const formatted = formatWithLineNumbers(
      sanitizeToolVisibleText(content, { codeFile: true }),
      offset,
      limit,
    );
    return {
      result: `File: ${textFilePath}\n${formatted.header}\n\n${formatted.body}`,
    };
  } catch (error) {
    return { error: `Error reading file: ${(error as Error).message}` };
  }
};

export const handleWrite = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const content = String(args.content ?? "");

  try {
    const { path: filePath, created } = await writeTextFile(
      args.file_path,
      content,
      context,
    );
    return {
      result: created ? `Created ${filePath}` : `Wrote ${filePath}`,
      fileChanges: [fileChange(filePath, { type: created ? "add" : "update" })],
    };
  } catch (error) {
    return { error: `Error writing file: ${(error as Error).message}` };
  }
};

export const handleEdit = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  try {
    const { path: filePath, replacements } = await replaceTextInFile(
      {
        filePath: args.file_path,
        oldString: String(args.old_string ?? ""),
        newString: String(args.new_string ?? ""),
        replaceAll: Boolean(args.replace_all ?? false),
      },
      context,
    );
    return {
      result: `Replaced ${replacements} occurrence(s) in ${filePath}`,
      fileChanges: [fileChange(filePath, { type: "update" })],
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
