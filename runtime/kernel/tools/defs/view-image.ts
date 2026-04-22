/**
 * `view_image` tool — read a local image and attach it as a vision input.
 *
 * Use only when the user gives an explicit absolute file path. The runtime's
 * tool adapter recognizes the result and turns the image into a vision
 * content block on the next assistant turn.
 */

import { handleViewImage } from "../view-image.js";
import type { ToolDefinition } from "../types.js";

export const viewImageTool: ToolDefinition = {
  name: "view_image",
  description:
    "Read a local image file from the filesystem and attach it to the conversation as a vision input. Use only when the user gives you an explicit absolute file path. Required: path.",
  promptSnippet: "Attach a local image file to the conversation",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Local filesystem path to an image file.",
      },
    },
    required: ["path"],
  },
  execute: (args, context) => handleViewImage(args, context),
};
