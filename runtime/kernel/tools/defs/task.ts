/**
 * Sub-agent management tools for the orchestrator.
 *
 * Three sibling tools that all manipulate the durable agent thread surface:
 * `spawn_agent` (start a thread), `send_input` (deliver a follow-up to a
 * running thread, transparently re-hydrating a paused/completed thread when
 * needed), and `pause_agent` (cancel without losing the thread). All three
 * are orchestrator-only.
 */

import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import {
  handleSendInput,
  handleSpawnAgent,
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

export const createAgentTools = (
  stateContext: StateContext,
): ToolDefinition[] => [
  {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent for a well-scoped background task. Returns immediately with a durable `thread_id`; the agent is NOT finished yet.",
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
            "Detailed instructions for the sub-agent. This is the agent's only context.",
        },
      },
      required: ["description", "prompt"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("spawn_agent", context);
      if (denied) return denied;
      return handleSpawnAgent(stateContext, args, context);
    },
  },
  {
    name: "send_input",
    description:
      "Send a follow-up message to an existing sub-agent. By default (interrupt=true), the agent's current attempt is stopped and restarted with this message — use this to redirect work mid-flight. With interrupt=false, the message is queued and the agent finishes its current turn first. If the agent is paused or already completed, it is re-hydrated and resumed with this message.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to continue or revise.",
        },
        message: {
          type: "string",
          description: "Follow-up instruction to deliver to the agent.",
        },
        interrupt: {
          type: "boolean",
          description:
            "When true (default), stop the agent's current attempt and apply this message immediately. When false, queue the message; the agent will see it after its current turn completes.",
        },
      },
      required: ["thread_id", "message"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("send_input", context);
      if (denied) return denied;
      return handleSendInput(stateContext, args, context);
    },
  },
  {
    name: "pause_agent",
    description:
      "Pause a running sub-agent. The same thread can be resumed later by calling send_input with its thread_id.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to pause.",
        },
        reason: {
          type: "string",
          description: "Optional explanation for why the agent is being paused.",
        },
      },
      required: ["thread_id"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("pause_agent", context);
      if (denied) return denied;
      return handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context);
    },
  },
];
