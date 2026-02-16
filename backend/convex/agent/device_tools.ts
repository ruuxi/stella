import { tool } from "ai";
import type { Value } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

/**
 * Sanitize tool names to comply with AI provider constraints.
 * Pattern required: [a-zA-Z0-9_-]+
 * Replaces dots with underscores.
 */
export const sanitizeToolName = (name: string): string =>
  name.replace(/\./g, "_");

export const CORE_DEVICE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "OpenApp",
  "Bash",
  "KillShell",
  "ShellStatus",
  "AskUserQuestion",
  "RequestCredential",
  "SkillBash",
  "MediaGenerate",
  "SelfModStart",
  "SelfModApply",
  "SelfModRevert",
  "SelfModStatus",
  "SelfModPackage",
  "ManagePackage",
] as const;

type DeviceToolName = (typeof CORE_DEVICE_TOOL_NAMES)[number] | string;

export type DeviceToolContext = {
  conversationId: Id<"conversations">;
  userMessageId?: Id<"events">;
  targetDeviceId: string;
  agentType: string;
  sourceDeviceId?: string;
  currentTaskId?: Id<"tasks">;
  ephemeral?: boolean; // If true, events will be deleted after the operation
};

const TOOL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatTruncationNote = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const totalLines =
    typeof item.totalLines === "number" ? item.totalLines : undefined;
  const outputLines =
    typeof item.outputLines === "number" ? item.outputLines : undefined;
  const totalBytes =
    typeof item.totalBytes === "number" ? item.totalBytes : undefined;
  const outputBytes =
    typeof item.outputBytes === "number" ? item.outputBytes : undefined;
  const truncatedBy =
    typeof item.truncatedBy === "string" ? item.truncatedBy : undefined;

  const parts: string[] = [];
  if (truncatedBy) parts.push(`by=${truncatedBy}`);
  if (typeof outputLines === "number" || typeof totalLines === "number") {
    parts.push(`lines=${outputLines ?? "?"}/${totalLines ?? "?"}`);
  }
  if (typeof outputBytes === "number" || typeof totalBytes === "number") {
    parts.push(`bytes=${outputBytes ?? "?"}/${totalBytes ?? "?"}`);
  }
  if (parts.length === 0) return null;
  return `[Output truncated: ${parts.join(", ")}]`;
};

const formatToolResult = (toolName: string, payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return `Tool ${toolName} completed.`;
  }

  const { result, error, details, truncation } = payload as {
    result?: unknown;
    error?: string;
    details?: unknown;
    truncation?: unknown;
  };
  const truncationNote =
    formatTruncationNote(truncation) ??
    (details && typeof details === "object"
      ? formatTruncationNote((details as Record<string, unknown>).truncation)
      : null);

  if (error) {
    return `ERROR: ${toolName} failed: ${error}`;
  }

  if (typeof result === "string") {
    return truncationNote ? `${result}\n\n${truncationNote}` : result;
  }

  try {
    const body =
      result && typeof result === "object"
        ? {
            ...(result as Record<string, unknown>),
            ...(truncationNote ? { _truncation: truncationNote } : {}),
          }
        : result ?? payload;
    return JSON.stringify(body, null, 2);
  } catch {
    return truncationNote
      ? `Tool ${toolName} completed.\n\n${truncationNote}`
      : `Tool ${toolName} completed.`;
  }
};

const waitForToolResult = async (
  ctx: ActionCtx,
  requestId: string,
  deviceId: string,
  timeoutMs: number,
): Promise<Doc<"events"> | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await ctx.runQuery(internal.events.getToolResultByRequestId, {
      requestId,
      deviceId,
    });
    if (event) {
      return event;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

export const executeDeviceTool = async (
  ctx: ActionCtx,
  context: DeviceToolContext,
  toolName: DeviceToolName,
  toolArgs: unknown,
) => {
  const requestId = crypto.randomUUID();

  await ctx.runMutation(internal.events.enqueueToolRequest, {
    conversationId: context.conversationId,
    requestId,
    targetDeviceId: context.targetDeviceId,
    toolName,
    toolArgs: toolArgs as Value,
    agentType: context.agentType,
    sourceDeviceId: context.sourceDeviceId,
    userMessageId: context.userMessageId,
  });

  const resultEvent = await waitForToolResult(
    ctx,
    requestId,
    context.targetDeviceId,
    TOOL_TIMEOUT_MS,
  );

  if (!resultEvent) {
    const error = `Tool ${toolName} timed out after ${Math.round(TOOL_TIMEOUT_MS / 1000)}s.`;
    try {
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: context.conversationId,
        type: "tool_result",
        deviceId: context.targetDeviceId,
        requestId,
        targetDeviceId: context.targetDeviceId,
        payload: {
          toolName,
          error,
          requestId,
          targetDeviceId: context.targetDeviceId,
        },
      });
    } catch {
      // Best-effort: timeout reporting should not fail tool execution.
    }
    return `ERROR: ${error}`;
  }

  return formatToolResult(toolName, resultEvent.payload);
};

export const createCoreDeviceTools = (ctx: ActionCtx, context: DeviceToolContext) => {
  const call = (name: DeviceToolName, args: unknown) =>
    executeDeviceTool(ctx, context, name, args);

  return {
    Read: tool({
      description:
        "Read a file from the local filesystem.\n\n" +
        "Usage:\n" +
        "- file_path must be an absolute path.\n" +
        "- By default reads up to 2000 lines from the start. Use offset and limit for large files.\n" +
        "- Returns content with line numbers (cat -n format).\n" +
        "- Always read a file before editing or overwriting it.\n" +
        "- Can read images (PNG, JPG, etc.) — contents are returned as visual data.",
      inputSchema: z.object({
        file_path: z.string().describe("Absolute path to the file to read"),
        offset: z.number().optional().describe("Line number to start reading from (1-based)"),
        limit: z.number().optional().describe("Max number of lines to read"),
      }),
      execute: (args) => call("Read", args),
    }),
    Write: tool({
      description:
        "Create or overwrite a file on the local filesystem.\n\n" +
        "Usage:\n" +
        "- file_path must be an absolute path.\n" +
        "- If the file exists, it will be completely overwritten. Read it first to understand current content.\n" +
        "- Parent directories are created automatically if they don't exist.\n" +
        "- Prefer Edit over Write for modifying existing files — it's safer and preserves unchanged content.",
      inputSchema: z.object({
        file_path: z.string().describe("Absolute path to the file to create or overwrite"),
        content: z.string().describe("The full file content to write"),
      }),
      execute: (args) => call("Write", args),
    }),
    Edit: tool({
      description:
        "Make exact string replacements in a file.\n\n" +
        "Usage:\n" +
        "- Read the file first. This tool will fail if you haven't read the file.\n" +
        "- old_string must match the file content exactly, including whitespace and indentation.\n" +
        "- The edit will FAIL if old_string appears more than once in the file. Provide more surrounding context to make it unique, or use replace_all=true to change every occurrence.\n" +
        "- Prefer this over Write for modifying existing files.",
      inputSchema: z.object({
        file_path: z.string().describe("Absolute path to the file to edit"),
        old_string: z.string().describe("Exact text to find and replace (must be unique unless replace_all=true)"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z.boolean().optional().describe("Replace all occurrences instead of requiring uniqueness"),
      }),
      execute: (args) => call("Edit", args),
    }),
    Glob: tool({
      description:
        "Find files by glob pattern.\n\n" +
        "Usage:\n" +
        "- Supports patterns like \"**/*.ts\", \"src/**/*.tsx\", \"*.json\".\n" +
        "- Returns matching file paths sorted by modification time (newest first).\n" +
        "- Use path to limit the search to a specific directory.\n" +
        "- Use this instead of Bash with find or ls.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern to match (e.g. \"**/*.ts\", \"src/**/*.json\")"),
        path: z.string().optional().describe("Directory to search in (defaults to working directory)"),
      }),
      execute: (args) => call("Glob", args),
    }),
    Grep: tool({
      description:
        "Search file contents using ripgrep regex.\n\n" +
        "Usage:\n" +
        "- pattern is a regular expression (e.g. \"function\\s+\\w+\", \"TODO|FIXME\").\n" +
        "- output_mode controls what's returned:\n" +
        "  - \"files_with_matches\" (default): just file paths that match.\n" +
        "  - \"content\": matching lines with context.\n" +
        "  - \"count\": number of matches per file.\n" +
        "- Use glob to filter by file pattern (e.g. \"*.ts\") or type for standard file types (e.g. \"js\", \"py\").\n" +
        "- Use this instead of Bash with grep or rg.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("File or directory to search in"),
        glob: z.string().optional().describe("Filter files by glob pattern (e.g. \"*.tsx\")"),
        type: z.string().optional().describe("Filter by file type (e.g. \"ts\", \"py\", \"json\")"),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("What to return: matching lines, file paths, or counts"),
        case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
        context_lines: z.number().optional().describe("Lines of context around each match (for output_mode=content)"),
        max_results: z.number().optional().describe("Maximum number of results to return"),
      }),
      execute: (args) => call("Grep", args),
    }),
    OpenApp: tool({
      description:
        "Launch an application on the local device.\n\n" +
        "Usage:\n" +
        "- Use this for opening desktop apps (e.g. Microsoft Word, VS Code, browser apps).\n" +
        "- app can be an app name or executable path.\n" +
        "- args are passed to the launched app.\n" +
        "- This tool launches and returns immediately (non-blocking).",
      inputSchema: z.object({
        app: z.string().min(1).describe("Application name or executable path to launch"),
        args: z.array(z.string()).optional().describe("Optional arguments passed to the app"),
        working_directory: z.string().optional().describe("Working directory for the launch context"),
      }),
      execute: (args) => call("OpenApp", args),
    }),
    Bash: tool({
      description:
        "Execute a shell command on the local device.\n\n" +
        "Usage:\n" +
        "- Prefer dedicated tools (Read, Write, Edit, Glob, Grep) over Bash for file operations.\n" +
        "- Default timeout is 120 seconds, max 600 seconds.\n" +
        "- When run_in_background=true, returns immediately with a shell_id. Use KillShell to stop it later.\n" +
        "- Use description to explain non-obvious commands (helps with logging and debugging).\n" +
        "- On Windows, commands run in Git Bash for consistent bash syntax.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute"),
        description: z.string().optional().describe("Human-readable description of what this command does"),
        timeout: z.number().optional().describe("Timeout in milliseconds (default 120000, max 600000)"),
        working_directory: z.string().optional().describe("Working directory for the command"),
        run_in_background: z.boolean().optional().describe("Run in background and return a shell_id immediately"),
      }),
      execute: (args) => call("Bash", args),
    }),
    KillShell: tool({
      description:
        "Stop a background shell process.\n\n" +
        "Usage:\n" +
        "- Use the shell_id returned by Bash when run_in_background=true.\n" +
        "- Returns the accumulated output from the killed process.",
      inputSchema: z.object({
        shell_id: z.string().describe("Shell ID returned by Bash with run_in_background=true"),
      }),
      execute: (args) => call("KillShell", args),
    }),
    ShellStatus: tool({
      description:
        "Check the status and output of a background shell process without killing it.\n\n" +
        "Usage:\n" +
        "- If shell_id is provided, returns status, elapsed time, and tail of output.\n" +
        "- If shell_id is omitted, lists all active/completed shells.\n" +
        "- Use tail_lines to control how many lines of output to retrieve (default 50).\n" +
        "- Use this to monitor long-running commands before deciding to KillShell.",
      inputSchema: z.object({
        shell_id: z.string().optional().describe("Shell ID to check. Omit to list all shells."),
        tail_lines: z.number().optional().describe("Number of output lines to return from the end (default 50)"),
      }),
      execute: (args) => call("ShellStatus", args),
    }),
    AskUserQuestion: tool({
      description:
        "Ask the user to choose between options via a UI prompt.\n\n" +
        "Usage:\n" +
        "- Present 1-4 questions, each with 2-4 options.\n" +
        "- The user can always select \"Other\" to provide free-form text input.\n" +
        "- Use multiSelect=true when choices aren't mutually exclusive.\n" +
        "- Use when you need user decisions on implementation choices, preferences, or clarifications.",
      inputSchema: z.object({
        questions: z.array(
          z.object({
            question: z.string().describe("The question to ask (end with ?)"),
            header: z.string().describe("Short label displayed as a tag (max 12 chars)"),
            options: z.array(
              z.object({
                label: z.string().describe("Option text (1-5 words)"),
                description: z.string().describe("What this option means or what happens if chosen"),
              }),
            ),
            multiSelect: z.boolean().describe("Allow selecting multiple options"),
          }),
        ),
      }),
      execute: (args) => call("AskUserQuestion", args),
    }),
    RequestCredential: tool({
      description:
        "Request an API key or secret from the user via a secure UI prompt.\n\n" +
        "Usage:\n" +
        "- Displays a secure input dialog where the user enters a credential.\n" +
        "- Returns a secretId handle (not the raw value) for use with IntegrationRequest or SkillBash.\n" +
        "- The secret is stored encrypted in the user's vault.\n" +
        "- Use provider as a unique key (e.g. \"openweather_api_key\"). Same provider reuses existing secret.",
      inputSchema: z.object({
        provider: z.string().min(1).describe("Unique key for this secret (e.g. \"github_token\")"),
        label: z.string().optional().describe("Display name shown to the user (e.g. \"GitHub Token\")"),
        description: z.string().optional().describe("Why this credential is needed"),
        placeholder: z.string().optional().describe("Input placeholder text"),
      }),
      execute: (args) => call("RequestCredential", args),
    }),
    SkillBash: tool({
      description:
        "Execute a shell command with a skill's secrets automatically mounted as environment variables or files.\n\n" +
        "Usage:\n" +
        "- Like Bash, but injects secrets defined in the skill's secretMounts config.\n" +
        "- skill_id must match a skill that has secretMounts configured.\n" +
        "- If the required secret doesn't exist, the user will be prompted via RequestCredential automatically.\n" +
        "- Use this instead of Bash when running commands that need API keys or tokens from a skill.",
      inputSchema: z.object({
        skill_id: z.string().min(1).describe("ID of the skill whose secrets to mount"),
        command: z.string().min(1).describe("Shell command to execute"),
        description: z.string().optional().describe("Human-readable description of what this command does"),
        timeout: z.number().optional().describe("Timeout in milliseconds (default 120000, max 600000)"),
        working_directory: z.string().optional().describe("Working directory for the command"),
        run_in_background: z.boolean().optional().describe("Run in background and return a shell_id"),
      }),
      execute: (args) => call("SkillBash", args),
    }),
    MediaGenerate: tool({
      description:
        "Generate or edit images and video.\n\n" +
        "Usage:\n" +
        "- mode=\"generate\": Create new media from a text prompt.\n" +
        "- mode=\"edit\": Modify an existing image/video (provide source_url).\n" +
        "- prompt describes what to generate or how to edit.\n" +
        "- media_type: \"image\" or \"video\".",
      inputSchema: z.object({
        mode: z.enum(["generate", "edit"]).default("generate").describe("Create new or edit existing"),
        media_type: z.enum(["image", "video"]).default("image").describe("Type of media to produce"),
        prompt: z.string().describe("Description of what to generate or how to edit"),
        source_url: z.string().optional().describe("URL of source media to edit (required for mode=edit)"),
      }),
      execute: (args) => call("MediaGenerate", args),
    }),
    SelfModStart: tool({
      description:
        "Start a new self-modification feature.\n\n" +
        "Usage:\n" +
        "- Groups related file changes under a named feature for atomic apply and revert.\n" +
        "- All subsequent Write/Edit calls go to a staging area, not the live source files.\n" +
        "- Call SelfModApply when the batch is complete to apply all changes at once.\n" +
        "- If a feature with this name already exists, it becomes the active feature.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Descriptive name for this modification (e.g. \"Compact Sidebar\")"),
        description: z.string().optional().describe("What this modification does"),
      }),
      execute: (args) => call("SelfModStart", args),
    }),
    SelfModApply: tool({
      description:
        "Apply all staged file changes atomically.\n\n" +
        "Usage:\n" +
        "- Copies staged files to the live source directory in one batch.\n" +
        "- Vite HMR picks up all changes simultaneously — the UI updates in one shot.\n" +
        "- Creates a revert point so changes can be undone with SelfModRevert.\n" +
        "- The user continues using the current UI while you stage changes — they only see the update when you apply.",
      inputSchema: z.object({
        message: z.string().optional().describe("Description of what this batch changes"),
      }),
      execute: (args) => call("SelfModApply", args),
    }),
    SelfModRevert: tool({
      description:
        "Revert applied changes, restoring source files to their previous state.\n\n" +
        "Usage:\n" +
        "- Restores the original files from the snapshot taken before SelfModApply.\n" +
        "- HMR updates the UI back to the previous state immediately.\n" +
        "- Use steps to revert multiple batches (default 1).",
      inputSchema: z.object({
        feature_id: z.string().optional().describe("Feature to revert (defaults to active feature)"),
        steps: z.number().optional().describe("Number of batches to revert (default 1)"),
      }),
      execute: (args) => call("SelfModRevert", args),
    }),
    SelfModStatus: tool({
      description:
        "Check the status of a self-modification feature.\n\n" +
        "Returns: staged files, applied batches, revert points, and the active feature name.",
      inputSchema: z.object({
        feature_id: z.string().optional().describe("Feature to check (defaults to active feature)"),
      }),
      execute: (args) => call("SelfModStatus", args),
    }),
    SelfModPackage: tool({
      description:
        "Package a completed feature as a shareable blueprint for the store.\n\n" +
        "Usage:\n" +
        "- Bundles the feature's reference code with description and implementation notes.\n" +
        "- Other users' AIs read the blueprint and reimplement the feature to fit their codebase.\n" +
        "- description: user-facing summary of what the feature does.\n" +
        "- implementation: developer-facing explanation — files changed, patterns used, architectural decisions. This is what another AI reads to re-implement.",
      inputSchema: z.object({
        feature_id: z.string().optional().describe("Feature to package (defaults to active feature)"),
        description: z.string().describe("User-facing summary of what the feature does"),
        implementation: z.string().describe("Developer-facing explanation of how the feature was implemented"),
      }),
      execute: (args) => call("SelfModPackage", args),
    }),
    ManagePackage: tool({
      description:
        "Install or uninstall a package locally under ~/.stella.\n\n" +
        "Usage:\n" +
        "- action=\"install\": install skill/theme/canvas package.\n" +
        "- action=\"uninstall\": uninstall skill/theme/canvas/mod by local ID.\n" +
        "- For mod installs, delegate to Self-Mod and use SelfModInstallBlueprint.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("install"),
          package: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("skill"),
              packageId: z.string().min(1).describe("Store package ID"),
              skillId: z.string().min(1).describe("Local skill ID"),
              name: z.string().min(1).describe("Skill name"),
              markdown: z.string().min(1).describe("Skill markdown content"),
              agentTypes: z.array(z.string()).optional().describe("Agent types this skill applies to"),
              tags: z.array(z.string()).optional().describe("Tags for the skill"),
            }),
            z.object({
              type: z.literal("theme"),
              packageId: z.string().min(1).describe("Store package ID"),
              themeId: z.string().min(1).describe("Local theme ID"),
              name: z.string().min(1).describe("Theme name"),
              light: z.record(z.string()).describe("Light mode color palette"),
              dark: z.record(z.string()).describe("Dark mode color palette"),
            }),
            z.object({
              type: z.literal("canvas"),
              packageId: z.string().min(1).describe("Store package ID"),
              workspaceId: z.string().optional().describe("Preferred workspace ID"),
              name: z.string().optional().describe("Workspace name"),
              dependencies: z.record(z.string()).optional().describe("Extra npm dependencies"),
              source: z.string().optional().describe("Initial App.tsx source"),
            }),
          ]),
        }),
        z.object({
          action: z.literal("uninstall"),
          package: z.object({
            type: z.enum(["skill", "theme", "canvas", "mod"]).describe("Package type"),
            localId: z.string().min(1).describe("Local identifier (skillId, themeId, workspaceId)"),
            packageId: z.string().optional().describe("Store package ID"),
          }),
        }),
      ]),
      execute: (args) => call("ManagePackage", args),
    }),
  };
};
