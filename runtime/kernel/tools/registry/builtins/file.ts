/**
 * Filesystem tools for the Exec registry: `read_file`, `write_file`, `glob`,
 * `search`. `apply_patch` lives in its own module for clarity.
 *
 * All paths are absolute. There is no implicit workspace restriction.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import picomatch from "picomatch";
import {
  formatWithLineNumbers,
  readFileSafe,
  truncate,
  walkFiles,
  toPosix,
  expandHomePath,
} from "../../utils.js";
import { isBlockedPath } from "../../command-safety.js";
import {
  readTextFile,
  writeTextFile,
} from "../../file.js";
import type { ExecToolDefinition } from "../registry.js";

const READ_FILE_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Absolute path to the file to read. Use process.cwd()-relative resolution explicitly if needed.",
    },
    offset: {
      type: "number",
      description: "Line number to start reading from (1-based, default 1).",
    },
    limit: {
      type: "number",
      description: "Max number of lines to read (default 2000).",
    },
  },
  required: ["path"],
} as const;

const WRITE_FILE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path to the file to write." },
    content: { type: "string", description: "Full file contents to write." },
  },
  required: ["path", "content"],
} as const;

const GLOB_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern (e.g. '**/*.ts'). Resolved relative to `path` (or process.cwd() if omitted).",
    },
    path: {
      type: "string",
      description:
        "Absolute base directory for the glob. Defaults to process.cwd().",
    },
  },
  required: ["pattern"],
} as const;

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regex pattern to search for." },
    path: {
      type: "string",
      description:
        "Absolute file or directory to search in. Defaults to process.cwd().",
    },
    glob: {
      type: "string",
      description: "Filter files by glob (e.g. '*.ts').",
    },
    type: {
      type: "string",
      description: "Filter by ripgrep file type (e.g. 'ts', 'py').",
    },
    mode: {
      type: "string",
      enum: ["content", "files", "count"],
      description: "What to return. Defaults to 'files'.",
    },
    case_insensitive: {
      type: "boolean",
      description: "Case-insensitive search.",
    },
    context_lines: {
      type: "number",
      description: "Lines of context (mode='content' only).",
    },
    max_results: {
      type: "number",
      description: "Cap on results (default 200).",
    },
  },
  required: ["pattern"],
} as const;

const ensureAbsolute = (raw: unknown, label: string): string => {
  const value = expandHomePath(String(raw ?? ""));
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
};

const runRipgrep = async (
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; output: string; error?: string }> =>
  new Promise((resolve) => {
    const child = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ ok: false, output: "", error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output: stdout });
      else if (code === 1) resolve({ ok: true, output: "" });
      else
        resolve({
          ok: false,
          output: stdout,
          error: stderr || `rg exited ${code}`,
        });
    });
  });

export const createFileBuiltins = (): ExecToolDefinition[] => [
  {
    name: "read_file",
    description:
      "Read a UTF-8 file from an absolute path. Returns `{ path, content, lines }` plus a `formatted` string (cat -n style) for inline display.",
    inputSchema: READ_FILE_SCHEMA,
    handler: async (rawArgs, context) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const filePath = ensureAbsolute(args.path, "path");
      const block = isBlockedPath(filePath);
      if (block) throw new Error(block);
      const offset = Number(args.offset ?? 1);
      const limit = Number(args.limit ?? 2000);
      const { path: resolved, content } = await readTextFile(filePath, context);
      const formatted = formatWithLineNumbers(content, offset, limit);
      return {
        path: resolved,
        content,
        lines: content.split("\n").length,
        formatted: `${formatted.header}\n\n${formatted.body}`,
      };
    },
  },
  {
    name: "write_file",
    description:
      "Write a full file at an absolute path, creating parents as needed. Prefer `apply_patch` for changes to existing files.",
    inputSchema: WRITE_FILE_SCHEMA,
    handler: async (rawArgs, context) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const filePath = ensureAbsolute(args.path, "path");
      const block = isBlockedPath(filePath);
      if (block) throw new Error(block);
      const content = String(args.content ?? "");
      const { path: resolved, created } = await writeTextFile(
        filePath,
        content,
        context,
      );
      return { path: resolved, created };
    },
  },
  {
    name: "glob",
    description:
      "List files matching a glob pattern under an absolute base directory (defaults to process.cwd()). Returns absolute paths.",
    inputSchema: GLOB_SCHEMA,
    handler: async (rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required.");
      const basePath = args.path
        ? ensureAbsolute(args.path, "path")
        : process.cwd();
      const block = isBlockedPath(basePath);
      if (block) throw new Error(block);
      const all = await walkFiles(basePath);
      const matcher = picomatch(pattern, {
        nocase: process.platform === "win32",
      });
      return all
        .map((entry) => ({ abs: entry, rel: toPosix(path.relative(basePath, entry)) }))
        .filter((entry) => matcher(entry.rel))
        .map((entry) => entry.abs)
        .sort();
    },
  },
  {
    name: "search",
    description:
      "Search file contents using ripgrep (with a JS fallback). Returns text formatted for the model in 'content' mode, an array of files in 'files' mode, and per-file counts in 'count' mode.",
    inputSchema: SEARCH_SCHEMA,
    handler: async (rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required.");
      const basePath = args.path
        ? ensureAbsolute(args.path, "path")
        : process.cwd();
      const block = isBlockedPath(basePath);
      if (block) throw new Error(block);
      const glob = args.glob ? String(args.glob) : undefined;
      const type = args.type ? String(args.type) : undefined;
      const mode =
        (args.mode as string | undefined) === "content"
          ? "content"
          : (args.mode as string | undefined) === "count"
            ? "count"
            : "files";
      const caseInsensitive = Boolean(args.case_insensitive ?? false);
      const contextLines = args.context_lines
        ? Number(args.context_lines)
        : undefined;
      const maxResults = args.max_results ? Number(args.max_results) : 200;

      const rgArgs: string[] = [];
      if (mode === "files") rgArgs.push("-l");
      if (mode === "count") rgArgs.push("-c");
      if (mode === "content") {
        rgArgs.push("-n");
        if (contextLines) rgArgs.push("-C", String(contextLines));
      }
      if (caseInsensitive) rgArgs.push("-i");
      if (glob) rgArgs.push("--glob", glob);
      if (type) rgArgs.push("--type", type);
      rgArgs.push("--max-count", String(maxResults));
      rgArgs.push(pattern, basePath);

      const result = await runRipgrep(rgArgs, basePath);
      if (result.ok) {
        const trimmed = result.output.trim();
        if (!trimmed) {
          if (mode === "files") return { mode, files: [] };
          if (mode === "count") return { mode, counts: [] };
          return { mode, text: `No matches for ${pattern}.` };
        }
        if (mode === "files") {
          return { mode, files: trimmed.split("\n").filter(Boolean) };
        }
        if (mode === "count") {
          return {
            mode,
            counts: trimmed
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const idx = line.lastIndexOf(":");
                return {
                  path: line.slice(0, idx),
                  count: Number(line.slice(idx + 1)),
                };
              }),
          };
        }
        return { mode, text: truncate(result.output) };
      }

      const fallback: string[] = [];
      const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
      const files = await walkFiles(basePath);
      const matcher = glob
        ? picomatch(glob, { nocase: process.platform === "win32" })
        : null;
      for (const file of files) {
        const relativePath = toPosix(path.relative(basePath, file));
        if (matcher && !matcher(relativePath)) continue;
        const read = await readFileSafe(file);
        if (!read.ok) continue;
        let count = 0;
        const lines = read.content.split("\n");
        lines.forEach((line, index) => {
          if (regex.test(line)) {
            count++;
            if (mode === "content") {
              fallback.push(`${file}:${index + 1}:${line}`);
            }
          }
          regex.lastIndex = 0;
        });
        if (count > 0) {
          if (mode === "files") fallback.push(file);
          else if (mode === "count") fallback.push(`${file}:${count}`);
        }
        if (fallback.length >= maxResults) break;
      }
      if (mode === "files") return { mode, files: fallback };
      if (mode === "count")
        return {
          mode,
          counts: fallback.map((line) => {
            const idx = line.lastIndexOf(":");
            return {
              path: line.slice(0, idx),
              count: Number(line.slice(idx + 1)),
            };
          }),
        };
      return { mode, text: truncate(fallback.join("\n")) };
    },
  },
];
