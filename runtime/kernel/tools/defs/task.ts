/**
 * Sub-agent management tools.
 *
 * Three tools manipulate the durable agent thread surface: `spawn_agent`,
 * `send_input`, and `pause_agent`. Exposure is two-tier and depends on who
 * owns the running thread, not only on its agent type:
 *
 *   - the orchestrator and a top-level (root-spawned) General agent get all
 *     three, so a General agent can run its own subagents;
 *   - a parent-owned General agent — one spawned BY another agent — gets the
 *     same toolset as a top-level General MINUS these three.
 *
 * The second tier is enforced by absence from the catalog rather than by the
 * depth-limit tool error, so a subagent cannot attempt a third level or steer
 * a sibling thread at all. See `getToolCatalog`'s `parentOwned` option.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  handleSendInput,
  handleSpawnAgent,
  type StateContext,
} from "../state.js";
import type { ToolDefinition } from "../types.js";

const AGENT_SPAWNERS: readonly string[] = [
  AGENT_IDS.ORCHESTRATOR,
  AGENT_IDS.GENERAL,
];

/**
 * Tools withheld from a parent-owned agent. Kept as one exported list so the
 * catalog filter and the execute-time gate can never drift apart.
 */
export const AGENT_ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "send_input",
  "pause_agent",
];

export const createAgentTools = (
  stateContext: StateContext,
): ToolDefinition[] => [
  {
    name: "spawn_agent",
    agentTypes: AGENT_SPAWNERS,
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
            "Optional model or engine for this one spawn. Omit (or pass `default`) to use the user's configured setup. Use `stella`, `codex`, or `claude-code` to explicitly select that engine with its configured model. A model reference (`stella/light`, `stella/max`, `anthropic/...`, `openrouter/<vendor>/<model>`) uses Stella's in-process engine even when Codex or Claude Code is selected globally; `codex/<model>` and `claude-code/<model>` pin an engine-native model. Closed model/engine forms may add `:low`, `:medium`, `:high`, or `:xhigh` for a per-spawn reasoning override (for example `stella:high`, `codex:xhigh`, or `stella/standard:medium`). Open-ended `openrouter/...`, `vercel-ai-gateway/...`, and `stella/<provider>/<model>` references keep colon segments verbatim, so effort suffixes are unavailable on those forms; use `stella:<effort>`, `default:<effort>`, or an engine-native `codex...` / `claude-code...` form when unambiguous effort control is required. Use ONLY when the user explicitly asked for it or has a recorded standing preference; when in doubt, omit.",
        },
      },
      required: ["description", "prompt"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, args, context),
  },
  {
    name: "send_input",
    agentTypes: AGENT_SPAWNERS,
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
          description:
            "One short, user-friendly sentence summarizing what this work is about.",
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
    agentTypes: AGENT_SPAWNERS,
    description:
      "Pause a running sub-agent, or a whole group of related agents at once by passing a grp-… group id. The same thread can be resumed later by calling send_input with its thread_id.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description:
            "Durable thread id to pause, or a grp-… group id to pause every agent in that group.",
        },
        reason: {
          type: "string",
          description:
            "Optional explanation for why the agent is being paused.",
        },
      },
      required: ["thread_id"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context),
  },
];
