/**
 * AI SDK tool wrappers for the local agent runtime.
 *
 * Wraps existing tool handlers (from tools.ts) as AI SDK tool() instances
 * with deterministic toolCallIds and lifecycle callbacks.
 */

import { tool } from "ai";
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

const toolSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  Read: z.object({
    file_path: z.string().describe("Absolute path to the file"),
    offset: z.number().optional().describe("Line number to start reading from"),
    limit: z.number().optional().describe("Number of lines to read"),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Write: z.object({
    file_path: z.string().describe("Absolute path to write to"),
    content: z.string().describe("File content"),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Edit: z.object({
    file_path: z.string().describe("Absolute path to edit"),
    old_string: z.string().describe("Text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Glob: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Search directory"),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Grep: z.object({
    pattern: z.string().describe("Regex pattern"),
    path: z.string().optional(),
    include: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Bash: z.object({
    command: z.string().describe("Shell command to run"),
    timeout: z.number().optional().describe("Timeout in ms"),
    background: z.boolean().optional(),
    description: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  OpenApp: z.object({
    name: z.string().describe("Application name or path"),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  KillShell: z.object({
    id: z.string().describe("Shell ID to kill"),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  ShellStatus: z.object({
    id: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  Task: z.object({
    description: z.string(),
    command: z.string().optional(),
    args: z.record(z.unknown()).optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  TaskOutput: z.object({
    id: z.string().describe("Task ID"),
    timeout: z.number().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  AskUserQuestion: z.object({
    question: z.string(),
    options: z.array(z.string()).optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModStart: z.object({
    featureId: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModApply: z.object({
    featureId: z.string(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModRevert: z.object({
    featureId: z.string(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModStatus: z.object({
    featureId: z.string().optional(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,

  SelfModPackage: z.object({
    featureId: z.string(),
  }).passthrough() as z.ZodType<Record<string, unknown>>,
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
  Task: "Create or manage a background task",
  TaskOutput: "Get output from a background task",
  AskUserQuestion: "Ask the user a question",
  SelfModStart: "Start a self-modification feature",
  SelfModApply: "Apply a self-modification feature",
  SelfModRevert: "Revert a self-modification feature",
  SelfModStatus: "Check self-modification status",
  SelfModPackage: "Package a self-modification feature",
};

// ─── Create Tools ────────────────────────────────────────────────────────────

export function createAgentTools(opts: CreateAgentToolsOpts): Record<string, ReturnType<typeof tool>> {
  const {
    agentType,
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

  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const [toolName, schema] of Object.entries(toolSchemas)) {
    if (!allowedTools.has(toolName)) continue;

    const description = toolDescriptions[toolName] ?? toolName;

    tools[toolName] = tool({
      description,
      parameters: schema,
      execute: async (args) => {
        const toolCallId = generateToolCallId(toolName, args as Record<string, unknown>);
        const context: ToolContext = {
          conversationId,
          deviceId,
          requestId: toolCallId,
          agentType,
        };

        callbacks.onToolCallStart(toolCallId, toolName);
        const startMs = Date.now();

        try {
          const result = await toolExecutor(toolName, args as Record<string, unknown>, context);
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
