/**
 * `apply_patch` tool — JSON wrapper around Stella's patch envelope.
 *
 * Accepts a single `input` string with the full
 * `*** Begin Patch` ... `*** End Patch` envelope. File paths in the envelope
 * MUST be absolute; the file tools do not resolve relative to any cwd.
 */

import { handleApplyPatch } from "../apply-patch.js";
import type { ToolDefinition } from "../types.js";

export const applyPatchTool: ToolDefinition = {
  name: "apply_patch",
  description:
    "Edit files via a *** Begin Patch / *** End Patch envelope. Supports Add File, Update File (with optional Move to), Delete File. Each Update File hunk is anchored by 3 lines of context above and below the change. File paths in the envelope MUST be absolute (e.g. /Users/you/projects/foo/bar.ts); relative paths are rejected and the file tools do NOT follow the shell's cwd. Required: input (the full patch text).",
  promptSnippet: "Edit files with patch envelopes",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The entire contents of the apply_patch envelope. All file paths inside must be absolute.",
      },
    },
    required: ["input"],
  },
  execute: (args, context) => handleApplyPatch(args, context),
};
