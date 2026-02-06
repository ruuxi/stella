import { tool } from "ai";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

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
  };
};
