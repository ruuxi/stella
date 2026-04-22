/**
 * `apply_patch` tool — Codex's JSON variant of the patch envelope.
 *
 * Single `input` string carrying a full
 * `*** Begin Patch` ... `*** End Patch` envelope. Works on every model the
 * freeform Lark grammar variant doesn't.
 */

import { handleApplyPatch } from "../apply-patch.js";
import type { ToolDefinition } from "../types.js";

export const applyPatchTool: ToolDefinition = {
  name: "apply_patch",
  description:
    "Edit files via a *** Begin Patch / *** End Patch envelope. Supports Add File, Update File (with optional Move to), Delete File. Each Update File hunk is anchored by 3 lines of context above and below the change. Required: input (the full patch text).",
  promptSnippet: "Edit files with patch envelopes",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The entire contents of the apply_patch envelope.",
      },
    },
    required: ["input"],
  },
  execute: (args) => handleApplyPatch(args),
};
