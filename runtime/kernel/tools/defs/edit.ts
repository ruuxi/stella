/**
 * `Edit` — replace text inside an existing file.
 */

import { handleEdit } from "../file.js";
import type { ToolDefinition } from "../types.js";

export const editTool: ToolDefinition = {
  name: "Edit",
  description:
    "Edit an existing text file by replacing old_string with new_string. Use replace_all only when every occurrence should change. Required: file_path, old_string, new_string.",
  promptSnippet: "Replace text inside an existing file",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute or repo-relative path to edit.",
      },
      old_string: {
        type: "string",
        description: "Exact text to replace. Must identify the intended span.",
      },
      new_string: {
        type: "string",
        description: "Replacement text. May be empty to delete text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence of old_string. Defaults to false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: (args, context) => handleEdit(args, context),
};

