import {
  NodeReplKernelRegistry,
  type NodeReplKernelManagerOptions,
} from "../../computer-use/kernel.js";
import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolDefinition } from "../types.js";

export type NodeReplToolOptions = NodeReplKernelManagerOptions & {
  registry?: NodeReplKernelRegistry;
};

export const createNodeReplTool = (
  options: NodeReplToolOptions,
): ToolDefinition => {
  const registry = options.registry ?? new NodeReplKernelRegistry(options);
  return {
    name: "node_repl",
    agentTypes: [AGENT_IDS.GENERAL],
    description:
      "Run JavaScript in a persistent Node REPL with top-level await. Setup is already done: bindings persist between calls, nodeRepl exposes write/emitImage and cwd/home/tmp, and frozen sky controls desktop apps. You may perform one or more sky actions before sky.get_app_state; use fresh element IDs from the latest state.",
    promptSnippet:
      "Run persistent JavaScript and control desktop apps through the frozen sky client",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript to evaluate with top-level await.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional evaluation timeout in milliseconds.",
        },
      },
      required: ["code"],
    },
    execute: async (args, context, extras) => {
      if (typeof args.code !== "string" || args.code.trim() === "") {
        return { error: "code is required." };
      }
      const timeoutMs =
        typeof args.timeout_ms === "number" &&
        Number.isFinite(args.timeout_ms) &&
        args.timeout_ms > 0
          ? Math.floor(args.timeout_ms)
          : undefined;
      try {
        const result = await registry.evaluate(args.code, context, {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(extras?.signal ? { signal: extras.signal } : {}),
        });
        return { result };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
