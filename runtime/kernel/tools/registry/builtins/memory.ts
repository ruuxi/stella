/**
 * Memory tool for the Exec registry. Mirrors the legacy local-dispatch
 * `Memory` tool: mutates the durable memory store in-process.
 */

import type {
  MemoryStore,
  MemoryTarget,
} from "../../../memory/memory-store.js";
import type { ExecToolDefinition } from "../registry.js";

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "replace", "remove"],
      description: "Mutation to apply.",
    },
    target: {
      type: "string",
      enum: ["memory", "user"],
      description: "'user' = identity store. 'memory' = your own notes.",
    },
    content: {
      type: "string",
      description:
        "New entry text (required for `add` and `replace`).",
    },
    oldText: {
      type: "string",
      description:
        "Substring identifying the entry to replace or remove (required for `replace` and `remove`).",
    },
  },
  required: ["action", "target"],
} as const;

export type MemoryBuiltinOptions = {
  memoryStore: MemoryStore;
  agentTypes?: readonly string[];
};

const isAction = (value: unknown): value is "add" | "replace" | "remove" =>
  value === "add" || value === "replace" || value === "remove";

const isTarget = (value: unknown): value is MemoryTarget =>
  value === "memory" || value === "user";

export const createMemoryBuiltins = (
  options: MemoryBuiltinOptions,
): ExecToolDefinition[] => [
  {
    name: "memory",
    description:
      "Mutate the durable memory store. Both `memory` and `user` stores appear at the top of every conversation, so writes appear next session.",
    ...(options.agentTypes ? { agentTypes: options.agentTypes } : {}),
    inputSchema: MEMORY_SCHEMA,
    handler: async (rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const action = isAction(args.action) ? args.action : null;
      const target = isTarget(args.target) ? args.target : null;
      if (!action) throw new Error("action must be one of: add, replace, remove.");
      if (!target) throw new Error("target must be one of: memory, user.");
      const content = typeof args.content === "string" ? args.content : "";
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      if (action === "add") return options.memoryStore.add(target, content);
      if (action === "replace")
        return options.memoryStore.replace(target, oldText, content);
      return options.memoryStore.remove(target, oldText);
    },
  },
];
