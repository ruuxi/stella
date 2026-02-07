import { tool, ToolSet } from "ai";
import { z } from "zod";
import { spritesExec } from "../agent/cloud_devices";

const MAX_OUTPUT = 30_000;

const truncate = (value: string, max = MAX_OUTPUT) =>
  value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;

const formatExecResult = (result: { stdout: string; stderr: string; exit_code: number }) => {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`STDERR: ${result.stderr}`);
  if (result.exit_code !== 0) parts.push(`Exit code: ${result.exit_code}`);
  return truncate(parts.join("\n") || "(no output)");
};

/**
 * Creates tool definitions that execute on a Sprites.dev cloud sandbox.
 * Each tool call translates to a REST API call to `POST /v1/sprites/{name}/exec`.
 * The sprite auto-wakes from sleep on the first call (1-2s latency).
 */
export const createCloudTools = (spriteName: string): ToolSet => {
  return {
    Bash: tool({
      description:
        "Execute a shell command in the cloud sandbox.",
      inputSchema: z.object({
        command: z.string(),
        description: z.string().optional(),
        timeout: z.number().optional(),
        working_directory: z.string().optional(),
      }),
      execute: async (args) => {
        const cmd = args.working_directory
          ? `cd "${args.working_directory}" && ${args.command}`
          : args.command;
        try {
          const result = await spritesExec(spriteName, cmd);
          return formatExecResult(result);
        } catch (error) {
          return `Bash failed: ${(error as Error).message}`;
        }
      },
    }),
    Read: tool({
      description: "Read a file in the cloud sandbox by absolute path.",
      inputSchema: z.object({
        file_path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }),
      execute: async (args) => {
        const offset = args.offset ?? 1;
        const limit = args.limit ?? 2000;
        try {
          // Use sed for offset/limit, cat -n for line numbers
          const cmd = `sed -n '${offset},${offset + limit - 1}p' "${args.file_path}" | cat -n`;
          const result = await spritesExec(spriteName, cmd);
          if (result.exit_code !== 0) {
            return result.stderr || `Failed to read ${args.file_path}`;
          }
          // Count total lines for header
          const wcResult = await spritesExec(spriteName, `wc -l < "${args.file_path}"`);
          const totalLines = wcResult.stdout.trim();
          return `File has ${totalLines} lines. Showing from line ${offset}.\n${truncate(result.stdout)}`;
        } catch (error) {
          return `Read failed: ${(error as Error).message}`;
        }
      },
    }),
    Write: tool({
      description: "Write a file in the cloud sandbox by absolute path.",
      inputSchema: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      execute: async (args) => {
        try {
          // Base64 encode to safely handle special characters
          const encoded = Buffer.from(args.content).toString("base64");
          const cmd = `mkdir -p "$(dirname "${args.file_path}")" && echo '${encoded}' | base64 -d > "${args.file_path}"`;
          const result = await spritesExec(spriteName, cmd);
          if (result.exit_code !== 0) {
            return `Write failed: ${result.stderr}`;
          }
          return `File written: ${args.file_path}`;
        } catch (error) {
          return `Write failed: ${(error as Error).message}`;
        }
      },
    }),
    Edit: tool({
      description: "Replace exact text in a file in the cloud sandbox.",
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async (args) => {
        try {
          // Use Python for reliable text replacement
          const oldEncoded = Buffer.from(args.old_string).toString("base64");
          const newEncoded = Buffer.from(args.new_string).toString("base64");
          const replaceAll = args.replace_all ? "True" : "False";
          const pyScript = `
import base64, sys
old = base64.b64decode("${oldEncoded}").decode()
new = base64.b64decode("${newEncoded}").decode()
path = "${args.file_path}"
with open(path, "r") as f:
    content = f.read()
count = content.count(old)
if count == 0:
    print("ERROR: old_string not found in file", file=sys.stderr)
    sys.exit(1)
if count > 1 and not ${replaceAll}:
    print(f"ERROR: old_string found {count} times. Use replace_all=true or provide more context.", file=sys.stderr)
    sys.exit(1)
if ${replaceAll}:
    content = content.replace(old, new)
else:
    content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print(f"Replaced {count if ${replaceAll} else 1} occurrence(s) in {path}")
`.trim();
          const result = await spritesExec(spriteName, `python3 -c '${pyScript.replace(/'/g, "'\\''")}'`);
          if (result.exit_code !== 0) {
            return result.stderr || "Edit failed";
          }
          return result.stdout || `Edited: ${args.file_path}`;
        } catch (error) {
          return `Edit failed: ${(error as Error).message}`;
        }
      },
    }),
    Glob: tool({
      description: "Find files by glob pattern in the cloud sandbox.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
      }),
      execute: async (args) => {
        const searchPath = args.path || "/home/sprite";
        try {
          const result = await spritesExec(
            spriteName,
            `find "${searchPath}" -name "${args.pattern}" -type f 2>/dev/null | head -100`,
          );
          if (!result.stdout.trim()) {
            return `No files matching "${args.pattern}" in ${searchPath}`;
          }
          return truncate(result.stdout);
        } catch (error) {
          return `Glob failed: ${(error as Error).message}`;
        }
      },
    }),
    Grep: tool({
      description: "Search file contents with ripgrep in the cloud sandbox.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        type: z.string().optional(),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
        case_insensitive: z.boolean().optional(),
        context_lines: z.number().optional(),
        max_results: z.number().optional(),
      }),
      execute: async (args) => {
        const searchPath = args.path || "/home/sprite";
        const parts = ["rg"];
        if (args.case_insensitive) parts.push("-i");
        if (args.output_mode === "files_with_matches") parts.push("-l");
        else if (args.output_mode === "count") parts.push("-c");
        if (args.context_lines) parts.push(`-C ${args.context_lines}`);
        if (args.glob) parts.push(`--glob '${args.glob}'`);
        if (args.type) parts.push(`--type ${args.type}`);
        parts.push(`"${args.pattern}"`);
        parts.push(`"${searchPath}"`);
        const maxResults = args.max_results ?? 200;
        parts.push(`| head -${maxResults}`);

        try {
          const result = await spritesExec(spriteName, parts.join(" "));
          if (!result.stdout.trim() && result.exit_code === 1) {
            return `No matches for "${args.pattern}" in ${searchPath}`;
          }
          return truncate(result.stdout || result.stderr);
        } catch (error) {
          return `Grep failed: ${(error as Error).message}`;
        }
      },
    }),
    SqliteQuery: tool({
      description:
        "Execute a read-only SQL query on a SQLite database in the cloud sandbox.",
      inputSchema: z.object({
        database_path: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
      }),
      execute: async (args) => {
        const limit = args.limit ?? 100;
        try {
          const result = await spritesExec(
            spriteName,
            `sqlite3 -header -column "${args.database_path}" "${args.query} LIMIT ${limit}"`,
          );
          if (result.exit_code !== 0) {
            return `SQLite error: ${result.stderr}`;
          }
          return truncate(result.stdout || "(no results)");
        } catch (error) {
          return `SqliteQuery failed: ${(error as Error).message}`;
        }
      },
    }),
  };
};
