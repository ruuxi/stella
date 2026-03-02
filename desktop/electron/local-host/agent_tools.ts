/**
 * AI SDK tool wrappers for the local agent runtime.
 *
 * Wraps existing tool handlers (from tools.ts) as AI SDK tool() instances
 * with deterministic toolCallIds and lifecycle callbacks.
 *
 * Schemas are imported from @stella/shared (canonical source of truth)
 * and extended with .passthrough() + alias fields for local flexibility.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ToolContext, ToolResult } from "./tools-types.js";
import {
  TOOL_SCHEMAS,
  TOOL_DESCRIPTIONS,
} from "@stella/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentToolCallbacks = {
  onToolCallStart: (toolCallId: string, toolName: string) => void;
  onToolCallEnd: (toolCallId: string, result: unknown, durationMs: number) => void;
};

export type CreateAgentToolsOpts = {
  runId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  toolsAllowlist?: string[];
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  deviceId: string;
  conversationId: string;
  callbacks: AgentToolCallbacks;
  generateToolCallId: (toolName: string, args: Record<string, unknown>) => string;
};

// ─── Tool Schemas ────────────────────────────────────────────────────────────
// Shared canonical schemas from @stella/shared, cast through `any` at the
// boundary to handle zod v3 (shared/backend) vs v4 (frontend) type mismatch.
// Runtime behavior is identical — this is purely a TypeScript type boundary.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLoose = (schema: any) => schema.passthrough() as z.ZodType<Record<string, unknown>>;

const looseObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough() as z.ZodType<Record<string, unknown>>;

const toolSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  // File & search tools — shared schemas (passthrough allows extra fields)
  Read: asLoose(TOOL_SCHEMAS.Read),
  Write: asLoose(TOOL_SCHEMAS.Write),
  Edit: asLoose(TOOL_SCHEMAS.Edit),
  Glob: asLoose(TOOL_SCHEMAS.Glob),
  Grep: asLoose(TOOL_SCHEMAS.Grep),

  // Shell tools — shared schemas with passthrough (aliases handled by normalizeArgs)
  Bash: asLoose(TOOL_SCHEMAS.Bash),
  // OpenApp: override app to optional since LLM might use `name` alias instead
  OpenApp: looseObject({
    app: z.string().optional().describe("Application name or executable path to launch"),
    name: z.string().optional().describe("Application name or path"),
    args: z.array(z.string()).optional().describe("Optional arguments passed to the app"),
    working_directory: z.string().optional().describe("Working directory for the launch context"),
  }),
  // KillShell: override shell_id to optional since LLM might use `id` alias
  KillShell: looseObject({
    shell_id: z.string().optional().describe("Shell ID returned by Bash with run_in_background=true"),
    id: z.string().optional().describe("Shell ID to kill"),
  }),
  ShellStatus: asLoose(TOOL_SCHEMAS.ShellStatus),

  // Task tools — local-only schemas
  TaskCreate: z.object({
    description: z.string(),
    prompt: z.string().optional(),
    command: z.string().optional(),
    subagent_type: z.string().optional(),
    subagentType: z.string().optional(),
    agentType: z.string().optional(),
    thread_id: z.string().optional(),
    threadId: z.string().optional(),
    thread_name: z.string().optional(),
    threadName: z.string().optional(),
    command_id: z.string().optional(),
    commandId: z.string().optional(),
    system_prompt_override: z.string().optional(),
    systemPromptOverride: z.string().optional(),
    parent_task_id: z.string().optional(),
    parentTaskId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Task: z.object({
    description: z.string(),
    prompt: z.string().optional(),
    command: z.string().optional(),
    subagent_type: z.string().optional(),
    subagentType: z.string().optional(),
    agentType: z.string().optional(),
    thread_id: z.string().optional(),
    threadId: z.string().optional(),
    thread_name: z.string().optional(),
    threadName: z.string().optional(),
    command_id: z.string().optional(),
    commandId: z.string().optional(),
    system_prompt_override: z.string().optional(),
    systemPromptOverride: z.string().optional(),
    parent_task_id: z.string().optional(),
    parentTaskId: z.string().optional(),
    task_id: z.string().optional(),
    action: z.string().optional(),
    reason: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  TaskOutput: z.object({
    id: z.string().optional().describe("Task ID"),
    task_id: z.string().optional().describe("Task ID"),
    timeout: z.number().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  TaskCancel: z.object({
    task_id: z.string().optional().describe("Task ID"),
    id: z.string().optional().describe("Task ID"),
    reason: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  // User interaction — use shared canonical schema
  AskUserQuestion: asLoose(TOOL_SCHEMAS.AskUserQuestion),

  // Self-mod tools — local-only schemas (SelfModStart, SelfModApply, SelfModStatus
  // are local-only and not in the shared package)
  SelfModStart: z.object({
    featureId: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModApply: z.object({
    featureId: z.string(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  // SelfModRevert/SelfModPackage — shared schemas (passthrough allows featureId alias)
  SelfModRevert: asLoose(TOOL_SCHEMAS.SelfModRevert),

  SelfModStatus: z.object({
    featureId: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModPackage: asLoose(TOOL_SCHEMAS.SelfModPackage),
};

// Tool descriptions — shared canonical descriptions with local-only additions
const toolDescriptions: Record<string, string> = {
  ...TOOL_DESCRIPTIONS,
  TaskCreate: "Create and run a background subagent task",
  Task:
    "Create or manage a background task. Supports action=create|cancel|message|inbox for bidirectional orchestrator/subagent messaging.",
  TaskOutput: "Get output from a background task, including recent activity and exchanged messages.",
  TaskCancel: "Cancel a running background task",
  SelfModStart: "Start a self-modification feature",
  SelfModApply: "Apply a self-modification feature",
  SelfModStatus: "Check self-modification status",
};

// ─── Create Tools ────────────────────────────────────────────────────────────

export function createAgentTools(opts: CreateAgentToolsOpts): Record<string, Tool<any, any>> {
  const {
    agentType,
    storageMode = "cloud",
    toolsAllowlist,
    toolExecutor,
    deviceId,
    conversationId,
    callbacks,
    generateToolCallId,
  } = opts;

  const allowedTools = toolsAllowlist
    ? new Set(toolsAllowlist)
    : new Set(Object.keys(toolSchemas));

  const tools: Record<string, Tool<any, any>> = {};

  const normalizeArgs = (
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> => {
    const normalized = { ...args };
    if (toolName === "Bash" || toolName === "SkillBash") {
      if (normalized.run_in_background === undefined && normalized.background !== undefined) {
        normalized.run_in_background = normalized.background;
      }
      if (normalized.working_directory === undefined && normalized.cwd !== undefined) {
        normalized.working_directory = normalized.cwd;
      }
    }
    if (toolName === "OpenApp") {
      if (normalized.app === undefined && normalized.name !== undefined) {
        normalized.app = normalized.name;
      }
    }
    if (toolName === "KillShell" || toolName === "ShellStatus") {
      if (normalized.shell_id === undefined && normalized.id !== undefined) {
        normalized.shell_id = normalized.id;
      }
    }
    if (toolName === "TaskOutput") {
      if (normalized.task_id === undefined && normalized.id !== undefined) {
        normalized.task_id = normalized.id;
      }
    }
    if (toolName === "TaskCancel") {
      if (normalized.task_id === undefined && normalized.id !== undefined) {
        normalized.task_id = normalized.id;
      }
      normalized.action = "cancel";
    }
    if (toolName === "TaskCreate") {
      normalized.action = "create";
    }
    // SelfMod: normalize camelCase featureId -> snake_case feature_id
    if (toolName === "SelfModRevert" || toolName === "SelfModPackage") {
      if (normalized.feature_id === undefined && normalized.featureId !== undefined) {
        normalized.feature_id = normalized.featureId;
      }
    }
    return normalized;
  };

  const resolveToolExecutorName = (toolName: string): string => {
    if (toolName === "TaskCreate" || toolName === "TaskCancel") {
      return toolName;
    }
    return toolName;
  };

  for (const [toolName, schema] of Object.entries(toolSchemas)) {
    if (!allowedTools.has(toolName)) continue;

    const description = toolDescriptions[toolName] ?? toolName;

    tools[toolName] = tool({
      description,
      inputSchema: schema,
      execute: async (args: Record<string, unknown>) => {
        const normalizedArgs = normalizeArgs(toolName, args as Record<string, unknown>);
        const executorToolName = resolveToolExecutorName(toolName);
        const toolCallId = generateToolCallId(toolName, normalizedArgs);
        const context: ToolContext = {
          conversationId,
          deviceId,
          requestId: toolCallId,
          agentType,
          storageMode,
        };

        callbacks.onToolCallStart(toolCallId, toolName);
        const startMs = Date.now();

        try {
          const result = await toolExecutor(executorToolName, normalizedArgs, context);
          const durationMs = Date.now() - startMs;

          if (result.error) {
            callbacks.onToolCallEnd(toolCallId, result.error, durationMs);
            return `Error: ${result.error}`;
          }

          const output = typeof result.result === "string"
            ? result.result
            : JSON.stringify(result.result);
          callbacks.onToolCallEnd(toolCallId, output, durationMs);
          return output;
        } catch (error) {
          const durationMs = Date.now() - startMs;
          const errMsg = (error as Error).message ?? "Unknown error";
          callbacks.onToolCallEnd(toolCallId, errMsg, durationMs);
          return `Error: ${errMsg}`;
        }
      },
    });
  }

  return tools;
}
