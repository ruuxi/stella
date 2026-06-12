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
  handleRunWorkflow,
  handleSearchThreads,
  handleSendInput,
  handleSpawnAgent,
  type StateContext,
} from "../state.js";
import type { ToolDefinition } from "../types.js";

const RUN_WORKFLOW_DESCRIPTION = [
  "Run a multi-agent workflow for work that genuinely needs SEVERAL agents — parallel research across sources, fan-out plus verification, multi-stage pipelines. You write a small JavaScript orchestration script; it runs in the background and you receive ONE [Agent completed] event carrying the script's return value. For single-agent work always use spawn_agent instead.",
  "",
  "Script API (the only globals available — no imports, no Node, no timers):",
  "- `await agent(prompt, {label?, schema?})` — run one agent with full machine access. Returns its final text, or a validated JSON value when `schema` (a JSON Schema object) is given. Each agent starts with zero context: prompts must be self-contained.",
  "- `await parallel([() => agent(...), ...])` — run thunks concurrently; a failed branch becomes null (filter with .filter(Boolean)).",
  "- `await pipeline(items, stage1, stage2, ...)` — run each item through all stages without barriers; stages receive (prev, originalItem, index); a throwing stage drops that item to null.",
  "- `log(\"short user-friendly progress line\")` — shown to the user as live status; narrate in plain language, never mention agents/scripts.",
  "- `return <value>` — what you receive when the workflow completes.",
  "",
  "Example:",
  "```js",
  'log("Comparing options");',
  "const findings = await parallel([",
  '  () => agent("Research X. Report ...", {label: "research-x", schema: {type: "object", properties: {summary: {type: "string"}}, required: ["summary"]}}),',
  '  () => agent("Research Y. Report ...", {label: "research-y", schema: {type: "object", properties: {summary: {type: "string"}}, required: ["summary"]}}),',
  "]);",
  'log("Writing the comparison");',
  "const valid = findings.filter(Boolean);",
  "const report = await agent(`Write a comparison based on: ${JSON.stringify(valid)}`, {label: \"synthesize\"});",
  "return report;",
  "```",
].join("\n");

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
        group: {
          type: "string",
          description:
            "Only when this spawn is one of several agents serving the SAME request: a short 2-4 word label for the overall goal, identical across those sibling calls (or an existing grp-… id to add work to that group). Omit for standalone work — most spawns are standalone.",
        },
      },
      required: ["description", "prompt"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, args, context),
  },
  {
    name: "run_workflow",
    agentTypes: ORCHESTRATOR_ONLY,
    description: RUN_WORKFLOW_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "One short, user-friendly sentence naming the overall goal. Becomes the workflow's display name.",
        },
        script: {
          type: "string",
          description:
            "The JavaScript orchestration script (see the tool description for the API). Top-level await and return are supported.",
        },
        group: {
          type: "string",
          description:
            "Optional: group this workflow with related threads — a short label or an existing grp-… id.",
        },
      },
      required: ["description", "script"],
    },
    execute: async (args, context) =>
      handleRunWorkflow(stateContext, args, context),
  },
  {
    name: "search_threads",
    agentTypes: ORCHESTRATOR_ONLY,
    description:
      "Find past work beyond what `# Other Threads` shows. Searches every thread ever spawned in this conversation — including old, finished, or no-longer-listed ones — by name, description, and summary. Call without a query to browse the most recent past work. Every returned thread_id can be resumed with send_input; prefer resuming found work over re-spawning it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words from the work you're looking for (topic, app name, what it did). Omit to list recent past work.",
        },
        limit: {
          type: "number",
          description: "Max results (default 12, max 25).",
        },
      },
      required: [],
    },
    execute: async (args, context) =>
      handleSearchThreads(stateContext, args, context),
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
