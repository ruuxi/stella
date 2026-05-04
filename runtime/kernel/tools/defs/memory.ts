/**
 * `Memory` — orchestrator-only durable memory mutation surface.
 *
 * Two stores: `target: "user"` (persistent identity facts) and
 * `target: "memory"` (orchestrator's own cross-session notes). Three
 * actions: `add`, `replace` (by `oldText` substring), `remove`.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { MemoryStore, MemoryTarget } from "../../memory/memory-store.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

export type MemoryToolOptions = {
  memoryStore: MemoryStore;
};

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

const isMemoryTarget = (value: unknown): value is MemoryTarget =>
  value === "memory" || value === "user";

const isMemoryAction = (
  value: unknown,
): value is "add" | "replace" | "remove" =>
  value === "add" || value === "replace" || value === "remove";

export const createMemoryTool = (
  options: MemoryToolOptions,
): ToolDefinition => ({
  name: "Memory",
  description:
    'Manage durable memory entries that survive across sessions (`target: "user"` or `target: "memory"`).',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "replace", "remove"],
        description: "Mutation to apply to the chosen target.",
      },
      target: {
        type: "string",
        enum: ["memory", "user"],
        description:
          "Which store to mutate. 'user' = identity store. 'memory' = your own notes.",
      },
      content: {
        type: "string",
        description:
          "Required for action=add and action=replace. The new entry text.",
      },
      oldText: {
        type: "string",
        description:
          "Required for action=replace and action=remove. A short unique substring identifying the entry.",
      },
    },
    required: ["action", "target"],
  },
  execute: async (args, context) => {
    const denied = requireOrchestrator("Memory", context);
    if (denied) return denied;
    const action = isMemoryAction(args.action) ? args.action : null;
    const target = isMemoryTarget(args.target) ? args.target : null;
    if (!action) {
      return { error: "action must be one of: add, replace, remove." };
    }
    if (!target) {
      return { error: "target must be one of: memory, user." };
    }
    const content = typeof args.content === "string" ? args.content : "";
    const oldText = typeof args.oldText === "string" ? args.oldText : "";

    if (action === "add") {
      return { result: options.memoryStore.add(target, content) };
    }
    if (action === "replace") {
      return { result: options.memoryStore.replace(target, oldText, content) };
    }
    return { result: options.memoryStore.remove(target, oldText) };
  },
});
