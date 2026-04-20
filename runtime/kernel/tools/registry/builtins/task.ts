/**
 * Task delegation tools (`task_create`, `task_update`, `task_pause`,
 * `task_output`) backed by the existing TaskToolApi.
 */

import {
  handleTask,
  handleTaskOutput,
  handleTaskUpdate,
  type StateContext,
} from "../../state.js";
import type { ToolResult } from "../../types.js";
import type { ExecToolDefinition } from "../registry.js";

const TASK_CREATE_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "Short summary of the task (shown in the task list).",
    },
    prompt: {
      type: "string",
      description:
        "Detailed instructions — the subagent's only context. Include user goal, constraints, and expected output.",
    },
  },
  required: ["description", "prompt"],
} as const;

const TASK_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    thread_id: { type: "string", description: "Durable thread id from `task_create`." },
    message: { type: "string", description: "Follow-up instruction to deliver." },
  },
  required: ["thread_id", "message"],
} as const;

const TASK_PAUSE_SCHEMA = {
  type: "object",
  properties: {
    thread_id: { type: "string", description: "Thread id to pause." },
    reason: { type: "string", description: "Optional reason." },
  },
  required: ["thread_id"],
} as const;

const TASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    thread_id: { type: "string", description: "Thread id to inspect." },
  },
  required: ["thread_id"],
} as const;

const unwrap = (result: ToolResult) => {
  if (result.error) throw new Error(result.error);
  return result.result;
};

export type TaskBuiltinOptions = {
  stateContext: StateContext;
  agentTypes?: readonly string[];
};

export const createTaskBuiltins = (
  options: TaskBuiltinOptions,
): ExecToolDefinition[] => {
  const agentTypes = options.agentTypes;
  const def = (
    tool: Omit<ExecToolDefinition, "agentTypes">,
  ): ExecToolDefinition =>
    agentTypes ? { ...tool, agentTypes } : tool;
  return [
    def({
      name: "task_create",
      description:
        "Spawn a new background General-agent task. Returns immediately with a durable `thread_id`. The task continues in the background; never claim it has finished from the return alone.",
      inputSchema: TASK_CREATE_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleTask(
            options.stateContext,
            { ...(rawArgs as Record<string, unknown>), action: "create" },
            context,
          ),
        ),
    }),
    def({
      name: "task_update",
      description:
        "Send a follow-up message to an existing task thread. Use this for continuations, retries, or revised instructions on the same thread.",
      inputSchema: TASK_UPDATE_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleTaskUpdate(
            options.stateContext,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    }),
    def({
      name: "task_pause",
      description:
        "Pause a running task. Stops the current attempt; the same thread can be continued later with `task_update`.",
      inputSchema: TASK_PAUSE_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleTask(
            options.stateContext,
            { ...(rawArgs as Record<string, unknown>), action: "cancel" },
            context,
          ),
        ),
    }),
    def({
      name: "task_output",
      description:
        "Check the status and output of a task thread. Returns a structured snapshot (running/completed/error/canceled).",
      inputSchema: TASK_OUTPUT_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleTaskOutput(
            options.stateContext,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    }),
  ];
};
