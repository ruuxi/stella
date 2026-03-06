import { tool, ToolSet } from "ai";
import { z } from "zod";
import type { ActionCtx } from "../_generated/server";
import { getSpritesTokenForOwner, spritesExec } from "../agent/cloud_devices";
import { getDangerousCommandReason } from "../agent/tool_schemas";

const MAX_OUTPUT = 30_000;

const truncate = (value: string, max = MAX_OUTPUT) => {
  if (value.length <= max) {
    return { text: value, truncated: false, outputChars: value.length, totalChars: value.length };
  }
  return {
    text: value.slice(0, max),
    truncated: true,
    outputChars: max,
    totalChars: value.length,
  };
};

const renderTruncated = (value: string, max = MAX_OUTPUT) => {
  const result = truncate(value, max);
  if (!result.truncated) return result.text;
  return `${result.text}\n\n[Output truncated: chars=${result.outputChars}/${result.totalChars}]`;
};

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

const WORKSPACE_USER = "workspace";
const WORKSPACE_HOME = "/home/workspace";

const formatExecResult = (result: { stdout: string; stderr: string; exit_code: number }) => {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`STDERR: ${result.stderr}`);
  if (result.exit_code !== 0) parts.push(`Exit code: ${result.exit_code}`);
  return renderTruncated(parts.join("\n") || "(no output)");
};


/**
 * Creates tool definitions that execute on a Sprites.dev cloud sandbox.
 * Each tool call translates to a REST API call to `POST /v1/sprites/{name}/exec`.
 * The sprite auto-wakes from sleep on the first call (1-2s latency).
 */
export const createCloudTools = (
  ctx: ActionCtx,
  ownerId: string,
  spriteName: string,
): ToolSet => {
  let workspaceReady = false;

  const ensureWorkspace = async () => {
    if (workspaceReady) return;
    const token = await getSpritesTokenForOwner(ctx, ownerId);
    await spritesExec(
      token,
      spriteName,
      "id workspace >/dev/null 2>&1 || (" +
        "useradd -m -d /home/workspace -s /bin/bash workspace && " +
        "chown -R workspace:workspace /home/workspace && " +
        "chmod 700 /home/sprite/stella-bridge 2>/dev/null; true" +
        ")",
    );
    workspaceReady = true;
  };

  const execOnSprite = async (command: string) => {
    await ensureWorkspace();
    const token = await getSpritesTokenForOwner(ctx, ownerId);
    return await spritesExec(
      token,
      spriteName,
      `sudo -u ${WORKSPACE_USER} -H bash -c ${shellSingleQuote(command)}`,
    );
  };

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
        const reason = getDangerousCommandReason(cmd);
        if (reason) {
          return `ERROR: Bash command blocked for safety (${reason}).`;
        }
        try {
          const result = await execOnSprite(cmd);
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
          const result = await execOnSprite(cmd);
          if (result.exit_code !== 0) {
            return result.stderr || `Failed to read ${args.file_path}`;
          }
          // Count total lines for header
          const wcResult = await execOnSprite(`wc -l < "${args.file_path}"`);
          const totalLines = wcResult.stdout.trim();
          return `File has ${totalLines} lines. Showing from line ${offset}.\n${renderTruncated(result.stdout)}`;
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
          const result = await execOnSprite(cmd);
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
          const result = await execOnSprite(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`);
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
        const searchPath = args.path || WORKSPACE_HOME;
        try {
          const result = await execOnSprite(
            `find "${searchPath}" -name "${args.pattern}" -type f 2>/dev/null | head -100`,
          );
          if (!result.stdout.trim()) {
            return `No files matching "${args.pattern}" in ${searchPath}`;
          }
          return renderTruncated(result.stdout);
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
        const searchPath = args.path || WORKSPACE_HOME;
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
          const result = await execOnSprite(parts.join(" "));
          if (!result.stdout.trim() && result.exit_code === 1) {
            return `No matches for "${args.pattern}" in ${searchPath}`;
          }
          return renderTruncated(result.stdout || result.stderr);
        } catch (error) {
          return `Grep failed: ${(error as Error).message}`;
        }
      },
    }),
  };
};
