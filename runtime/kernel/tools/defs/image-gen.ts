/**
 * `image_gen` tool — run a still image job through Stella's managed media
 * gateway. The call stays pending through generation and durable artifact
 * materialization, then returns terminal status and local output paths.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import { createMediaToolHandlers } from "../media.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

export type ImageGenToolOptions = {
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
};

export const createImageGenTool = (
  options: ImageGenToolOptions,
): ToolDefinition => {
  const handlers = createMediaToolHandlers(options);
  const handler = handlers.image_gen as ToolHandler;
  return {
    name: "image_gen",
    // Audience declaration: image generation is for the orchestrator and the
    // Fashion agent. The General agent (and any other subagent) is denied at
    // both the catalog filter and executeTool via this gate.
    agentTypes: [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.FASHION],
    description:
      "Generate a still image through Stella's managed media gateway. The call stays pending until generation succeeds or fails. Success returns the terminal job status, artifact metadata, and durable local path(s) under ~/.stella/media/outputs/. Do not poll, download, retry, or open the result yourself. Required: prompt.",
    promptSnippet:
      "Generate a still image and return its terminal artifact result",
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
        size: {
          type: "object",
          description:
            "Optional explicit pixel dimensions. Only set this when the default aspectRatio presets won't do (e.g. sprite atlases at non-standard sizes). Subject to the model envelope: max edge ≤ 3840, 655,360 ≤ width × height ≤ 8,294,400, longest edge ≤ 3× shortest edge.",
          properties: {
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
          },
          required: ["width", "height"],
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
