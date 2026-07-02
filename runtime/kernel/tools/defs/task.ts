/**
 * Sub-agent management tools for the orchestrator.
 *
 * Three sibling tools that all manipulate the durable agent thread surface:
 * `spawn_agent` (start a thread), `send_input` (deliver a follow-up to a
 * running thread, transparently re-hydrating a paused/completed thread when
 * needed), and `pause_agent` (cancel without losing the thread). All three
 * are orchestrator-only — gated declaratively via `agentTypes`, enforced by
 * both the catalog filter and the executeTool dispatcher in `tools/host.ts`.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  handleSendInput,
  handleSpawnAgent,
  type StateContext,
} from "../state.js";
import type { ToolDefinition } from "../types.js";

const ORCHESTRATOR_ONLY: readonly string[] = [AGENT_IDS.ORCHESTRATOR];

export const createAgentTools = (
  stateContext: StateContext,
): ToolDefinition[] => [
  {
    name: "spawn_agent",
    agentTypes: ORCHESTRATOR_ONLY,
    description:
      "Spawn a sub-agent for a well-scoped background task. Returns immediately with a durable `thread_id`; the agent is NOT finished yet.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "One short, user-friendly sentence summarizing what this work is about. It becomes the thread's name — put the distinguishing words first.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed instructions for the sub-agent. This is the agent's only context.",
        },
        model: {
          type: "string",
          description:
            "Optional model or engine for this one spawn. Omit (or pass `default`) to use the user's configured setup. Accepts a model reference (`stella/light`, `stella/max`, `anthropic/...`, `openrouter/<vendor>/<model>`) or an engine — `codex` / `claude-code` for the engine's configured model, `codex/<model>` / `claude-code/<model>` to pin one. Use ONLY when the user explicitly asked for it or has a recorded standing preference; when in doubt, omit.",
        },
        group: {
          type: "string",
          description:
            "Only when this spawn is one of several agents serving the SAME request: a short 2-4 word label for the overall goal, identical across those sibling calls (or an existing grp-… id to add work to that group). A group holds at most 8 threads. Omit for standalone work — most spawns are standalone.",
        },
      },
      required: ["description", "prompt"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, args, context),
  },
  {
    name: "send_input",
    agentTypes: ORCHESTRATOR_ONLY,
    description:
      "Send a follow-up message to an existing sub-agent. The agent sees it right away. If you want the message to land after the agent has finished its current work, wait for the [Agent completed] event on that thread first.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to continue or revise.",
        },
        description: {
          type: "string",
          description: "One short, user-friendly sentence summarizing what this work is about.",
        },
        message: {
          type: "string",
          description: "Follow-up instruction to deliver to the agent.",
        },
      },
      required: ["thread_id", "description", "message"],
    },
    execute: async (args, context) =>
      handleSendInput(stateContext, args, context),
  },
  {
    name: "pause_agent",
    agentTypes: ORCHESTRATOR_ONLY,
    description:
      "Pause a running sub-agent, or a whole group of related agents at once by passing a grp-… group id. The same thread can be resumed later by calling send_input with its thread_id.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to pause, or a grp-… group id to pause every agent in that group.",
        },
        reason: {
          type: "string",
          description: "Optional explanation for why the agent is being paused.",
        },
      },
      required: ["thread_id"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context),
  },
];
