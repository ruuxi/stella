/**
 * AI SDK tool wrappers for the local agent runtime.
 *
 * Wraps existing tool handlers (from tools.ts) as AI SDK tool() instances
 * with deterministic toolCallIds and lifecycle callbacks.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ToolContext, ToolResult } from "./tools-types.js";

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
// Minimal schemas that match what the device tools expect.
// The AI model provides arguments; we pass them through to the existing handlers.

const looseObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();

const toolSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  Read: looseObject({
    file_path: z.string().describe("Absolute path to the file"),
    offset: z.number().optional().describe("Line number to start reading from"),
    limit: z.number().optional().describe("Number of lines to read"),
  }) as z.ZodType<Record<string, unknown>>,

  Write: looseObject({
    file_path: z.string().describe("Absolute path to write to"),
    content: z.string().describe("File content"),
  }) as z.ZodType<Record<string, unknown>>,

  Edit: looseObject({
    file_path: z.string().describe("Absolute path to edit"),
    old_string: z.string().describe("Text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  Glob: looseObject({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Search directory"),
  }) as z.ZodType<Record<string, unknown>>,

  Grep: looseObject({
    pattern: z.string().describe("Regex pattern"),
    path: z.string().optional(),
    include: z.string().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  Bash: looseObject({
    command: z.string().describe("Shell command to run"),
    timeout: z.number().optional().describe("Timeout in ms"),
    run_in_background: z.boolean().optional(),
    background: z.boolean().optional(),
    working_directory: z.string().optional(),
    cwd: z.string().optional(),
    description: z.string().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  OpenApp: looseObject({
    app: z.string().optional().describe("Application name or executable path"),
    name: z.string().optional().describe("Application name or path"),
    args: z.array(z.string()).optional(),
    working_directory: z.string().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  KillShell: looseObject({
    shell_id: z.string().optional().describe("Shell ID to kill"),
    id: z.string().optional().describe("Shell ID to kill"),
  }) as z.ZodType<Record<string, unknown>>,

  ShellStatus: looseObject({
    shell_id: z.string().optional(),
    id: z.string().optional(),
    tail_lines: z.number().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  TaskCreate: looseObject({
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
  }) as z.ZodType<Record<string, unknown>>,

  Task: looseObject({
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
  }) as z.ZodType<Record<string, unknown>>,

  TaskOutput: looseObject({
    id: z.string().optional().describe("Task ID"),
    task_id: z.string().optional().describe("Task ID"),
    timeout: z.number().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  TaskCancel: looseObject({
    task_id: z.string().optional().describe("Task ID"),
    id: z.string().optional().describe("Task ID"),
    reason: z.string().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  AskUserQuestion: looseObject({
    question: z.string(),
    options: z.array(z.string()).optional(),
  }) as z.ZodType<Record<string, unknown>>,

  SelfModStart: looseObject({
    featureId: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  SelfModApply: looseObject({
    featureId: z.string(),
  }) as z.ZodType<Record<string, unknown>>,

  SelfModRevert: looseObject({
    featureId: z.string(),
  }) as z.ZodType<Record<string, unknown>>,

  SelfModStatus: looseObject({
    featureId: z.string().optional(),
  }) as z.ZodType<Record<string, unknown>>,

  SelfModPackage: looseObject({
    featureId: z.string(),
  }) as z.ZodType<Record<string, unknown>>,
};

// Tool descriptions for the AI model
const toolDescriptions: Record<string, string> = {
  Read: "Read a file from the filesystem",
  Write: "Write content to a file",
  Edit: "Replace text in a file",
  Glob: "Find files matching a glob pattern",
  Grep: "Search file contents with regex",
  Bash: "Execute a shell command",
  OpenApp: "Open an application",
  KillShell: "Kill a running shell process",
  ShellStatus: "Check status of shell processes",
  TaskCreate: "Create and run a background subagent task",
  Task: "Create or manage a background task",
  TaskOutput: "Get output from a background task",
  TaskCancel: "Cancel a running background task",
  AskUserQuestion: "Ask the user a question",
  SelfModStart: "Start a self-modification feature",
  SelfModApply: "Apply a self-modification feature",
  SelfModRevert: "Revert a self-modification feature",
  SelfModStatus: "Check self-modification status",
  SelfModPackage: "Package a self-modification feature",
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

