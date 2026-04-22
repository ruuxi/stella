/**
 * `Read` — local file read tool used by the Explore + Dream subagents.
 *
 * In the Dream subagent context, `dispatchLocalTool` intercepts and applies
 * path restrictions (only files under `state/memories` and
 * `state/memories_extensions`). In all other contexts the host's
 * `handleRead` runs directly.
 */

import { handleRead } from "../file.js";
import type { ToolDefinition } from "../types.js";

export const readTool: ToolDefinition = {
  name: "Read",
  description: "Read a file from the filesystem (internal).",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute or repo-relative file path.",
      },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  },
  execute: (args, context) => handleRead(args, context),
};
