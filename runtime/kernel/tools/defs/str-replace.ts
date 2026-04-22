/**
 * `StrReplace` — surgical text replacement, used exclusively by the Dream
 * subagent.
 *
 * Dream's runtime intercepts via `dispatchLocalTool` (which enforces
 * path-restricted writes to `MEMORY.md`, `memory_summary.md`, and
 * `raw_memories.md`). The host doesn't have an unrestricted handler for
 * this tool — calling it outside the Dream subagent returns an error.
 */

import type { ToolDefinition } from "../types.js";

export const strReplaceTool: ToolDefinition = {
  name: "StrReplace",
  description:
    "Surgically replace exact text inside an existing file. old_string must uniquely identify the target unless replace_all is true.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute file path to mutate. The file must already exist.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to replace. Must be unique within the file unless replace_all is true.",
      },
      new_string: {
        type: "string",
        description: "Replacement text. May be empty to delete.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence of old_string. Defaults to false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: async () => ({
    error:
      "StrReplace is only available inside the Dream subagent runtime " +
      "(which routes the call through path-restricted local dispatch).",
  }),
};
