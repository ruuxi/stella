/**
 * `apply_patch` tool — JSON wrapper around Stella's patch envelope.
 *
 * Accepts a single `input` string with the full
 * `*** Begin Patch` ... `*** End Patch` envelope. File paths in the envelope
 * are typically relative and resolved against the turn cwd.
 */

import { handleApplyPatch } from "../apply-patch.js";
import type { ToolDefinition } from "../types.js";

export const applyPatchTool: ToolDefinition = {
  name: "apply_patch",
  description:
    "Edit files via a *** Begin Patch / *** End Patch envelope. Supports Add File, Update File (with optional Move to), Delete File. Each Update File hunk is anchored by 3 lines of context above and below the change. File paths are relative to the turn cwd. Required: input (the full patch text). Optional: workdir to override the cwd for path resolution.",
  promptSnippet: "Edit files with patch envelopes",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The entire contents of the apply_patch envelope.",
      },
      workdir: {
        type: "string",
        description:
          "Optional working directory used to resolve relative paths in the envelope. Defaults to the turn cwd.",
      },
    },
    required: ["input"],
  },
  execute: (args, context) => handleApplyPatch(args, context),
};
