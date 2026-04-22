/**
 * `Grep` — local ripgrep wrapper used by the Explore subagent.
 */

import { handleGrep } from "../search.js";
import type { ToolDefinition } from "../types.js";

export const grepTool: ToolDefinition = {
  name: "Grep",
  description: "Search file contents using ripgrep (internal).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      type: { type: "string" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
      },
      case_insensitive: { type: "boolean" },
      context_lines: { type: "number" },
      max_results: { type: "number" },
    },
    required: ["pattern"],
  },
  execute: (args, context) => handleGrep(args, context),
};
