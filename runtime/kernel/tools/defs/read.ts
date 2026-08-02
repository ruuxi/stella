/**
 * `Read` — local text and image file reader.
 *
 * In the Dream subagent context, `dispatchLocalTool` intercepts and applies
 * path restrictions (only files under `~/.stella/memories` and
 * `~/.stella/memories_extensions`). In all other contexts the host's
 * `handleRead` runs directly.
 */

import { handleRead } from "../file.js";
import type { ToolDefinition } from "../types.js";

export const readTool: ToolDefinition = {
  name: "Read",
  description:
    "Read a text file or inspect a local PNG, JPG, JPEG, GIF, or WEBP image. Image files are attached to the conversation as vision input.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "Absolute text or image file path. Must be absolute (~ / $HOME expansion allowed); relative paths are rejected.",
      },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  },
  execute: (args, context) => handleRead(args, context),
};
