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
  "Run a multi-agent workflow for work that genuinely needs SEVERAL agents — parallel research across sources, gather-then-verify, fan-out plus synthesis. You write a small JavaScript orchestration script; it runs in the background and you receive ONE [Agent completed] event carrying the script's return value. For single-agent work always use spawn_agent instead.",
  "",
  "Script API (the only globals besides standard JS builtins — no imports, no Node, no timers):",
  "- `await agent(prompt, {label?, schema?})` — run one agent with full machine access. Returns its final text, or a validated JSON value when `schema` is given. Each agent starts with zero context: prompts must be self-contained, with every fact the agent needs written into them.",
  "- A failed agent() THROWS. Inside parallel()/pipeline() the failure is absorbed (that branch/item becomes null); a bare top-level await that throws fails the whole workflow — wrap optional steps in try/catch.",
  "- `schema` supports only: type, properties, required, items, enum, additionalProperties, and min/max bounds. Anything else (pattern, oneOf, format…) is silently ignored — do not rely on it.",
  "- `await parallel([() => agent(...), ...])` — run thunks concurrently; failed branches become null (filter with .filter(Boolean)).",
  "- `await pipeline(items, stage1, stage2, ...)` — each item flows through all stages independently, with NO barrier between stages. Stages receive (prev, originalItem, index); stage 1 receives the item itself. A throwing stage drops that item to null and skips its remaining stages.",
  "- `log(\"short user-friendly progress line\")` — live status shown to the user; plain language, never agents/scripts/machinery.",
  "- `return <value>` — the workflow's only output. Nothing else survives, so return everything worth keeping.",
  "",
  "Hard limits — size the script so it cannot hit them mid-run: 4 agents run at once (more queue); 64 agent() calls total — the 65th throws, and every schema-repair retry counts toward it; 45 minutes total; log() goes silent after 200 lines. Prefer 10 well-aimed agents over 50 thin ones, and bound every loop with a round counter, never a condition alone.",
  "",
  "Structure: default to pipeline() for multi-stage work — item A runs stage 2 while item B is still in stage 1. Insert a parallel() barrier between stages ONLY when the next stage needs ALL previous results at once (final synthesis, dedup, a decision over the whole set). Back-to-back parallel() calls where one pipeline() would do throw away the time the fast branches saved.",
  "",
  "Shapes that work (the prompt wording inside them matters as much as the structure):",
  "",
  "Sweep then synthesize — independent angles, one combined answer:",
  "```js",
  'log("Looking from a few angles");',
  "const angles = await parallel([",
  '  () => agent("...", {label: "official-sources"}),',
  '  () => agent("...", {label: "reviews-and-forums"}),',
  '  () => agent("...", {label: "price-history"}),',
  "]);",
  'log("Putting it together");',
  "return await agent(`Combine into one recommendation, noting where sources disagree: ${JSON.stringify(angles.filter(Boolean))}`, {label: \"synthesize\"});",
  "```",
  "",
  "Gather then verify — never hand the user unchecked findings. Verifiers must be told to DISPROVE; an agent asked to \"check\" tends to agree:",
  "```js",
  'const VERDICT = {type: "object", properties: {verdict: {enum: ["confirmed", "unconfirmed", "wrong"]}, note: {type: "string"}}, required: ["verdict", "note"]};',
  "const findings = await parallel([/* ...gather agents... */]);",
  'log("Double-checking the details");',
  "const checked = await pipeline(findings.filter(Boolean), (f) =>",
  "  agent(`Try to DISPROVE this finding by re-checking the source independently: ${JSON.stringify(f)}. If you cannot positively confirm it, the verdict is unconfirmed.`, {label: \"verify\", schema: VERDICT})",
  "    .then((v) => ({...f, ...v})));",
  'return checked.filter(Boolean).filter((c) => c.verdict !== "wrong");',
  "```",
  "",
  "Loop until done — discovery of unknown size: bounded rounds, each told what is already found:",
  "```js",
  "const seen = new Set(); const all = [];",
  "for (let round = 0; round < 4; round++) {",
  '  const batch = await agent(`Find <items> NOT already in this list: ${JSON.stringify([...seen])}. …`, {label: `round-${round + 1}`, schema: {type: "object", properties: {items: {type: "array", items: {type: "string"}}}, required: ["items"]}});',
  "  const fresh = batch.items.filter((i) => !seen.has(i));",
  "  if (fresh.length === 0) break;",
  "  fresh.forEach((i) => seen.add(i)); all.push(...fresh);",
  "}",
  "return all;",
  "```",
  "",
  'Scale to the ask: a quick comparison is 2-4 agents; "find the best", "be thorough", or anything the user will act on earns a wider sweep plus a verify pass. When unsure, err small — a follow-up workflow is cheap.',
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
            "Only when this spawn is one of several agents serving the SAME request: a short 2-4 word label for the overall goal, identical across those sibling calls (or an existing grp-… id to add work to that group). A group holds at most 8 threads — wider fan-outs belong in run_workflow. Omit for standalone work — most spawns are standalone.",
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
            "Words from the work you're looking for (topic, app name, what it did). Results need not match every word — the best-matching threads rank first. Omit to list recent past work.",
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
