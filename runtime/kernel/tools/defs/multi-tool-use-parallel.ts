/**
 * `multi_tool_use.parallel` tool — fan-out wrapper.
 *
 * Pass `tool_uses` as an array of `{ recipient_name, parameters }` entries;
 * each entry runs in parallel and the combined results are returned. Only
 * batch calls that don't depend on each other and stay within the same tool
 * family — never mix `computer_*` with `exec_command`.
 *
 * Needs a `executeTool` callback that re-enters the host's dispatcher for
 * each child call.
 */

import { handleMultiToolUseParallel } from "../parallel.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolUpdateCallback,
} from "../types.js";

export type MultiToolUseParallelOptions = {
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
};

export const createMultiToolUseParallelTool = (
  options: MultiToolUseParallelOptions,
): ToolDefinition => ({
  name: "multi_tool_use.parallel",
  description:
    "Run several independent tool calls concurrently. Pass `tool_uses` as an array of `{ recipient_name, parameters }` entries; each entry runs in parallel and the combined results are returned. Only batch calls that don't depend on each other (e.g. multiple file reads, or a snapshot per app), and stay within the same tool family — never mix `computer_*` with `exec_command`.",
  promptSnippet: "Fan out independent tool calls in parallel",
  parameters: {
    type: "object",
    properties: {
      tool_uses: {
        type: "array",
        description:
          "Independent tool calls to run concurrently. Each entry is `{ recipient_name: 'functions.<name>', parameters: { ... } }`.",
        items: {
          type: "object",
          properties: {
            recipient_name: { type: "string" },
            parameters: { type: "object" },
          },
          required: ["recipient_name", "parameters"],
        },
      },
    },
    required: ["tool_uses"],
  },
  execute: (args, context, extras) =>
    handleMultiToolUseParallel(
      { executeTool: options.executeTool },
      args,
      context,
      extras,
    ),
});
