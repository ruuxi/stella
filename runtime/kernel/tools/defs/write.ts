/**
 * `Write` — replace or create a whole text file.
 */

import { handleWrite } from "../file.js";
import type { ToolDefinition } from "../types.js";

export const writeTool: ToolDefinition = {
  name: "Write",
  description:
    "Create or overwrite a text file. Use for new files or when replacing the full file content. file_path MUST be an absolute path (e.g. /Users/you/projects/foo/bar.ts); relative paths are rejected and the file tools do NOT follow the shell's cwd. Required: file_path, content.",
  promptSnippet: "Create or overwrite a text file",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "Absolute path to write. Must be absolute (~ / $HOME expansion allowed); relative paths are rejected.",
      },
      content: {
        type: "string",
        description: "Full text content to write to the file.",
      },
    },
    required: ["file_path", "content"],
  },
  execute: (args, context) => handleWrite(args, context),
};

