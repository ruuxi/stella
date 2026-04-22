/**
 * Task management tools for the orchestrator.
 *
 * Four sibling tools that all manipulate the durable task thread surface:
 * `TaskCreate` (start a thread), `TaskUpdate` (deliver a follow-up to a
 * running thread), `TaskPause` (cancel without losing the thread), and
 * `TaskOutput` (poll status / output of a thread). All four are
 * orchestrator-only.
 */

import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import {
  handleTask,
  handleTaskOutput,
  handleTaskUpdate,
  type StateContext,
} from "../state.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

export const createTaskTools = (
  stateContext: StateContext,
): ToolDefinition[] => [
  {
    name: "TaskCreate",
    description:
      "Create a background task executed by the General agent. Returns immediately with a durable `thread_id`; the task is NOT finished yet.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short summary shown in the task list.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed instructions for the General agent. This is the agent's only context.",
        },
      },
      required: ["description", "prompt"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("TaskCreate", context);
      if (denied) return denied;
      return handleTask(stateContext, { ...args, action: "create" }, context);
    },
  },
  {
    name: "TaskUpdate",
    description:
      "Continue or revise an existing task thread by sending it a new message.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to continue or revise.",
        },
        message: {
          type: "string",
          description: "Follow-up instruction to deliver to the task thread.",
        },
      },
      required: ["thread_id", "message"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("TaskUpdate", context);
      if (denied) return denied;
      return handleTaskUpdate(stateContext, args, context);
    },
  },
  {
    name: "TaskPause",
    description:
      "Pause a running task thread. The same thread can be resumed later with TaskUpdate.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to pause.",
        },
        reason: {
          type: "string",
          description: "Optional explanation for why the task is being paused.",
        },
      },
      required: ["thread_id"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("TaskPause", context);
      if (denied) return denied;
      return handleTask(stateContext, { ...args, action: "cancel" }, context);
    },
  },
  {
    name: "TaskOutput",
    description: "Check the current status and output of a task thread.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id returned by TaskCreate.",
        },
      },
      required: ["thread_id"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("TaskOutput", context);
      if (denied) return denied;
      return handleTaskOutput(stateContext, args, context);
    },
  },
];
