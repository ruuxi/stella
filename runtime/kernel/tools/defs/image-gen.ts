/**
 * `image_gen` tool — generate a still image through Stella's managed media
 * gateway. The result is saved under `~/.stella/media/outputs/` and surfaced in
 * the sidebar; the model should not download or open it itself.
 */

import { createMediaToolHandlers } from "../media.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

export type ImageGenToolOptions = {
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  queryConvex?: (
    ref: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

export const createImageGenTool = (
  options: ImageGenToolOptions,
): ToolDefinition => {
  const handlers = createMediaToolHandlers(options);
  const handler = handlers.image_gen as ToolHandler;
  return {
    name: "image_gen",
    description:
      "Generate a still image through Stella's managed media gateway. The result is saved under `~/.stella/media/outputs/` and shown in the sidebar; do not download or open it yourself. Required: prompt.",
    promptSnippet: "Generate a still image via Stella's managed media gateway",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Description of the image to generate. Be specific about subject, style, framing, color, lighting, and any text overlays.",
        },
        aspectRatio: {
          type: "string",
          description:
            "Optional aspect ratio (e.g. '1:1', '16:9', '9:16', '4:3'). Defaults to the gateway's recommended ratio.",
        },
        profile: {
          type: "string",
          enum: ["best", "fast"],
          description:
            "Optional model profile. Use 'fast' for Fashion try-ons and quick drafts.",
        },
        referenceImagePaths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional local image paths to use as reference inputs. When any reference is provided the gateway switches from text_to_image to image_edit.",
        },
        referenceImageUrls: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional remote http(s) image URLs to use as reference inputs. Mix with referenceImagePaths when you have a local subject photo plus catalog product photos.",
        },
      },
      required: ["prompt"],
    },
    execute: handler,
  };
};
