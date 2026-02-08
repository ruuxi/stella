import { tool } from "ai";
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
  "Bash",
  "AskUserQuestion",
  "RequestCredential",
  "SkillBash",
  "SqliteQuery",
  "MediaGenerate",
  "CreateWorkspace",
  "StartDevServer",
  "StopDevServer",
  "ListWorkspaces",
  "SelfModStart",
  "SelfModApply",
  "SelfModRevert",
  "SelfModStatus",
  "SelfModPackage",
  "InstallSkillPackage",
  "InstallThemePackage",
  "InstallCanvasPackage",
  "InstallPluginPackage",
  "UninstallPackage",
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

const formatToolResult = (toolName: string, payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return `Tool ${toolName} completed.`;
  }

  const { result, error } = payload as {
    result?: unknown;
    error?: string;
  };

  if (error) {
    return `ERROR: ${toolName} failed: ${error}`;
  }

  if (typeof result === "string") {
    return result;
  }

  try {
    return JSON.stringify(result ?? payload, null, 2);
  } catch {
    return `Tool ${toolName} completed.`;
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
    toolArgs,
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
      description: "Read a local file by absolute path.",
      inputSchema: z.object({
        file_path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }),
      execute: (args) => call("Read", args),
    }),
    Write: tool({
      description: "Write a local file by absolute path.",
      inputSchema: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      execute: (args) => call("Write", args),
    }),
    Edit: tool({
      description: "Replace exact text in a local file.",
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: (args) => call("Edit", args),
    }),
    Glob: tool({
      description: "Find files by glob pattern.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
      }),
      execute: (args) => call("Glob", args),
    }),
    Grep: tool({
      description: "Search file contents with ripgrep.",
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
      execute: (args) => call("Grep", args),
    }),
    Bash: tool({
      description:
        "Execute a shell command on the local device. To kill a background shell, pass kill_shell_id instead of command.",
      inputSchema: z.object({
        command: z.string().optional(),
        description: z.string().optional(),
        timeout: z.number().optional(),
        working_directory: z.string().optional(),
        run_in_background: z.boolean().optional(),
        kill_shell_id: z.string().optional(),
      }),
      execute: (args) => call("Bash", args),
    }),
    AskUserQuestion: tool({
      description: "Ask the user to choose between options.",
      inputSchema: z.object({
        questions: z.array(
          z.object({
            question: z.string(),
            header: z.string(),
            options: z.array(
              z.object({
                label: z.string(),
                description: z.string(),
              }),
            ),
            multiSelect: z.boolean(),
          }),
        ),
      }),
      execute: (args) => call("AskUserQuestion", args),
    }),
    RequestCredential: tool({
      description:
        "Request a private API key via a secure UI flow. Returns a secretId handle.",
      inputSchema: z.object({
        provider: z.string().min(1),
        label: z.string().optional(),
        description: z.string().optional(),
        placeholder: z.string().optional(),
      }),
      execute: (args) => call("RequestCredential", args),
    }),
    SkillBash: tool({
      description: "Execute a shell command using a skill's configured secret mounts.",
      inputSchema: z.object({
        skill_id: z.string().min(1),
        command: z.string().min(1),
        description: z.string().optional(),
        timeout: z.number().optional(),
        working_directory: z.string().optional(),
        run_in_background: z.boolean().optional(),
      }),
      execute: (args) => call("SkillBash", args),
    }),
    SqliteQuery: tool({
      description:
        "Execute a read-only SQL query on a local SQLite database. Only SELECT and PRAGMA queries are allowed.",
      inputSchema: z.object({
        database_path: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
      }),
      execute: (args) => call("SqliteQuery", args),
    }),
    MediaGenerate: tool({
      description:
        "Generate or edit media. mode: generate (create new), edit (modify existing). media_type: image or video.",
      inputSchema: z.object({
        mode: z.enum(["generate", "edit"]).default("generate"),
        media_type: z.enum(["image", "video"]).default("image"),
        prompt: z.string(),
        source_url: z.string().optional(),
      }),
      execute: (args) => call("MediaGenerate", args),
    }),
    CreateWorkspace: tool({
      description:
        "Create a new workspace mini-app under the workspace root (default ~/workspaces/{name}, configurable via STELLA_WORKSPACES_ROOT) with legacy fallback. Installs dependencies.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Workspace name"),
        dependencies: z
          .record(z.string())
          .optional()
          .describe("Extra npm dependencies, e.g. { 'three': '^0.170.0' }"),
        source: z
          .string()
          .optional()
          .describe("Initial App.tsx source code"),
      }),
      execute: (args) => call("CreateWorkspace", args),
    }),
    StartDevServer: tool({
      description:
        "Start the Vite dev server for a workspace. Returns { url, port }.",
      inputSchema: z.object({
        workspaceId: z.string().min(1).describe("Workspace ID"),
      }),
      execute: (args) => call("StartDevServer", args),
    }),
    StopDevServer: tool({
      description: "Stop a running workspace dev server.",
      inputSchema: z.object({
        workspaceId: z.string().min(1).describe("Workspace ID"),
      }),
      execute: (args) => call("StopDevServer", args),
    }),
    ListWorkspaces: tool({
      description:
        "List all workspaces under the workspace root (default ~/workspaces, plus legacy fallback) with their running status.",
      inputSchema: z.object({}),
      execute: (args) => call("ListWorkspaces", args),
    }),
    SelfModStart: tool({
      description:
        "Start a new self-modification feature. Groups related file changes under a named feature for atomic apply and revert.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Descriptive name for this modification"),
        description: z.string().optional().describe("What this modification does"),
      }),
      execute: (args) => call("SelfModStart", args),
    }),
    SelfModApply: tool({
      description:
        "Apply all staged file changes atomically. Vite HMR will update the UI in one batch. Creates a revert point.",
      inputSchema: z.object({
        message: z.string().optional().describe("Description of what this batch changes"),
      }),
      execute: (args) => call("SelfModApply", args),
    }),
    SelfModRevert: tool({
      description:
        "Revert the last applied batch of changes, restoring source files to their previous state.",
      inputSchema: z.object({
        feature_id: z.string().optional().describe("Feature to revert (defaults to active feature)"),
        steps: z.number().optional().describe("Number of batches to revert (default 1)"),
      }),
      execute: (args) => call("SelfModRevert", args),
    }),
    SelfModStatus: tool({
      description:
        "Check the status of the current self-modification feature: staged files, applied batches, revert points.",
      inputSchema: z.object({
        feature_id: z.string().optional().describe("Feature to check (defaults to active feature)"),
      }),
      execute: (args) => call("SelfModStatus", args),
    }),
    SelfModPackage: tool({
      description:
        "Package a completed feature as a shareable blueprint. Requires description and implementation notes for other AIs to re-implement the feature.",
      inputSchema: z.object({
        feature_id: z.string().optional().describe("Feature to package (defaults to active feature)"),
        description: z.string().describe("User-facing summary of what the feature does"),
        implementation: z.string().describe("Developer-facing explanation of how the feature was implemented — files changed, patterns used, architectural decisions"),
      }),
      execute: (args) => call("SelfModPackage", args),
    }),
    InstallSkillPackage: tool({
      description:
        "Install a skill package locally from the app store. Writes skill files to ~/.stella/skills/.",
      inputSchema: z.object({
        packageId: z.string().min(1).describe("Store package ID"),
        skillId: z.string().min(1).describe("Local skill ID"),
        name: z.string().min(1).describe("Skill name"),
        markdown: z.string().min(1).describe("Skill markdown content"),
        agentTypes: z.array(z.string()).optional().describe("Agent types this skill applies to"),
        tags: z.array(z.string()).optional().describe("Tags for the skill"),
      }),
      execute: (args) => call("InstallSkillPackage", args),
    }),
    InstallThemePackage: tool({
      description:
        "Install a theme package locally from the app store. Writes theme JSON to ~/.stella/themes/.",
      inputSchema: z.object({
        packageId: z.string().min(1).describe("Store package ID"),
        themeId: z.string().min(1).describe("Local theme ID"),
        name: z.string().min(1).describe("Theme name"),
        light: z.record(z.string()).describe("Light mode color palette"),
        dark: z.record(z.string()).describe("Dark mode color palette"),
      }),
      execute: (args) => call("InstallThemePackage", args),
    }),
    InstallCanvasPackage: tool({
      description:
        "Install a mini-app/canvas package locally as a workspace under /workspaces/{name}/ (legacy fallback supported).",
      inputSchema: z.object({
        packageId: z.string().min(1).describe("Store package ID"),
        workspaceId: z.string().optional().describe("Preferred workspace ID"),
        name: z.string().min(1).describe("Workspace name"),
        dependencies: z.record(z.string()).optional().describe("Extra npm dependencies"),
        source: z.string().optional().describe("Initial App.tsx source"),
      }),
      execute: (args) => call("InstallCanvasPackage", args),
    }),
    InstallPluginPackage: tool({
      description:
        "Install a plugin package locally to ~/.stella/plugins/ from store payload files and manifest.",
      inputSchema: z.object({
        packageId: z.string().min(1).describe("Store package ID"),
        pluginId: z.string().optional().describe("Local plugin ID"),
        name: z.string().optional().describe("Plugin display name"),
        version: z.string().optional().describe("Plugin version"),
        description: z.string().optional().describe("Plugin description"),
        manifest: z.record(z.any()).optional().describe("plugin.json object"),
        files: z.record(z.string()).optional().describe("Relative file map to write"),
      }),
      execute: (args) => call("InstallPluginPackage", args),
    }),
    UninstallPackage: tool({
      description:
        "Uninstall a package locally. Removes files from ~/.stella/ based on type.",
      inputSchema: z.object({
        packageId: z.string().min(1).describe("Store package ID"),
        type: z.enum(["skill", "theme", "canvas", "plugin", "mod"]).describe("Package type"),
        localId: z.string().min(1).describe("Local identifier (skillId, themeId, workspaceId)"),
      }),
      execute: (args) => call("UninstallPackage", args),
    }),
  };
};
