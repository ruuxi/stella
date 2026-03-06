import { tool } from "ai";
import type { Value } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  type DeviceToolName as SharedDeviceToolName,
  getDangerousCommandReason,
  TOOL_SCHEMAS,
  TOOL_DESCRIPTIONS,
} from "@stella/shared";
import { sleep } from "../lib/async";

/**
 * Sanitize tool names to comply with AI provider constraints.
 * Pattern required: [a-zA-Z0-9_-]+
 * Replaces dots with underscores.
 */
export const sanitizeToolName = (name: string): string =>
  name.replace(/\./g, "_");

export { DEVICE_TOOL_NAMES as CORE_DEVICE_TOOL_NAMES } from "@stella/shared";
export const CLOUD_ONLY_TOOL_NAMES = ["WebFetch", "WebSearch"] as const;

type DeviceToolName = SharedDeviceToolName | string;

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
    // best-effort: fall back to plain text if result is not JSON-serializable
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
  const cleanupEphemeralEvents = async () => {
    if (!context.ephemeral) {
      return;
    }
    try {
      await ctx.runMutation(internal.events.deleteEventsByRequestId, {
        conversationId: context.conversationId,
        requestId,
      });
    } catch (err) {
      console.warn("[device_tools] Ephemeral cleanup failed:", err);
    }
  };

  try {
    await ctx.runMutation(internal.events.enqueueToolRequest, {
      conversationId: context.conversationId,
      requestId,
      targetDeviceId: context.targetDeviceId,
      toolName,
      toolArgs: toolArgs as Value,
      agentType: context.agentType,
      sourceDeviceId: context.sourceDeviceId,
      userMessageId: context.userMessageId,
      ephemeral: context.ephemeral === true,
    });

    const resultEvent = await waitForToolResult(
      ctx,
      requestId,
      context.targetDeviceId,
      TOOL_TIMEOUT_MS,
    );

    if (!resultEvent) {
      const error = `Tool ${toolName} timed out after ${Math.round(TOOL_TIMEOUT_MS / 1000)}s.`;
      if (!context.ephemeral) {
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
        } catch (err) {
          console.warn("[device_tools] Timeout reporting failed:", err);
        }
      }
      return `ERROR: ${error}`;
    }

    return formatToolResult(toolName, resultEvent.payload);
  } finally {
    await cleanupEphemeralEvents();
  }
};

export const createCoreDeviceTools = (ctx: ActionCtx, context: DeviceToolContext) => {
  const call = (name: DeviceToolName, args: unknown) =>
    executeDeviceTool(ctx, context, name, args);

  return {
    Read: tool({
      description: TOOL_DESCRIPTIONS.Read,
      inputSchema: TOOL_SCHEMAS.Read,
      execute: (args) => call("Read", args),
    }),
    Edit: tool({
      description: TOOL_DESCRIPTIONS.Edit,
      inputSchema: TOOL_SCHEMAS.Edit,
      execute: (args) => call("Edit", args),
    }),
    Glob: tool({
      description: TOOL_DESCRIPTIONS.Glob,
      inputSchema: TOOL_SCHEMAS.Glob,
      execute: (args) => call("Glob", args),
    }),
    Grep: tool({
      description: TOOL_DESCRIPTIONS.Grep,
      inputSchema: TOOL_SCHEMAS.Grep,
      execute: (args) => call("Grep", args),
    }),
    OpenApp: tool({
      description: TOOL_DESCRIPTIONS.OpenApp,
      inputSchema: TOOL_SCHEMAS.OpenApp,
      execute: (args) => call("OpenApp", args),
    }),
    Bash: tool({
      description: TOOL_DESCRIPTIONS.Bash,
      inputSchema: TOOL_SCHEMAS.Bash,
      execute: (args) => {
        const reason = getDangerousCommandReason(args.command);
        if (reason) {
          return `ERROR: Bash command blocked for safety (${reason}).`;
        }
        return call("Bash", args);
      },
    }),
    KillShell: tool({
      description: TOOL_DESCRIPTIONS.KillShell,
      inputSchema: TOOL_SCHEMAS.KillShell,
      execute: (args) => call("KillShell", args),
    }),
    ShellStatus: tool({
      description: TOOL_DESCRIPTIONS.ShellStatus,
      inputSchema: TOOL_SCHEMAS.ShellStatus,
      execute: (args) => call("ShellStatus", args),
    }),
    AskUserQuestion: tool({
      description: TOOL_DESCRIPTIONS.AskUserQuestion,
      inputSchema: TOOL_SCHEMAS.AskUserQuestion,
      execute: (args) => call("AskUserQuestion", args),
    }),
    RequestCredential: tool({
      description: TOOL_DESCRIPTIONS.RequestCredential,
      inputSchema: TOOL_SCHEMAS.RequestCredential,
      execute: (args) => call("RequestCredential", args),
    }),
    SkillBash: tool({
      description: TOOL_DESCRIPTIONS.SkillBash,
      inputSchema: TOOL_SCHEMAS.SkillBash,
      execute: (args) => {
        const reason = getDangerousCommandReason(args.command);
        if (reason) {
          return `ERROR: SkillBash command blocked for safety (${reason}).`;
        }
        return call("SkillBash", args);
      },
    }),
    MediaGenerate: tool({
      description: TOOL_DESCRIPTIONS.MediaGenerate,
      inputSchema: TOOL_SCHEMAS.MediaGenerate,
      execute: (args) => call("MediaGenerate", args),
    }),
  };
};
