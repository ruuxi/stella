/**
 * `image_gen` tool — run a still image job through the user's selected image
 * provider. The call stays pending through durable terminal settlement.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import { MAX_MANAGED_IMAGE_REFERENCE_ITEMS } from "../managed-image-references.js";
import { createMediaToolHandlers } from "../media.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

export type ImageGenToolOptions = {
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
};

// JSON Schema cannot express a sum of array lengths directly. Reject every
// positive partition whose minimum lengths add up to MAX + 1; larger mixed
// inputs necessarily match one of the same partitions. Per-array maxItems
// below handles the one-sided cases.
const combinedReferenceImageLimit = {
  not: {
    anyOf: Array.from(
      { length: MAX_MANAGED_IMAGE_REFERENCE_ITEMS },
      (_, pathIndex) => ({
        required: ["referenceImagePaths", "referenceImageUrls"],
        properties: {
          referenceImagePaths: { minItems: pathIndex + 1 },
          referenceImageUrls: {
            minItems: MAX_MANAGED_IMAGE_REFERENCE_ITEMS - pathIndex,
          },
        },
      }),
    ),
  },
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
      "Generate a still image through the image provider selected in Settings (Stella managed or the user's own OpenAI, OpenRouter, or Fal account). The call stays pending until success, failure, cancellation, or a structured unknown outcome, including durable artifact handoff. Success returns terminal status, artifact metadata, and local path(s) under ~/.stella/media/outputs/. Never retry or parallel-submit a pending call; Stella reattaches when the provider exposes durable identity and never blindly resubmits an ambiguous BYOK request. Do not poll, download, or open the result yourself. Required: prompt.",
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
          maxItems: MAX_MANAGED_IMAGE_REFERENCE_ITEMS,
          description:
            "Optional local image paths to use as reference inputs. At most four total references may be supplied across paths and URLs. Managed generation safely normalizes local bytes into a bounded upload envelope. When any reference is provided the gateway switches from text_to_image to image_edit.",
        },
        referenceImageUrls: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_MANAGED_IMAGE_REFERENCE_ITEMS,
          description:
            "Optional remote http(s) image URLs or validated data:image URLs to use as reference inputs. At most four total references may be supplied across URLs and paths. Mix with referenceImagePaths when you have a local subject photo plus catalog product photos.",
        },
        allowManagedReferenceUpload: {
          type: "boolean",
          description:
            "Required whenever local or inline bytes are sent through the Stella managed provider, including referenceImagePaths, attachment-derived data URLs, and data:image entries in referenceImageUrls. Set true only when the user explicitly asked to use those images; references are uploaded encrypted for managed processing and removed after submission settles. Remote http(s) URLs do not require this flag. BYOK providers receive references directly and do not use Stella managed storage.",
        },
      },
      required: ["prompt"],
      allOf: [combinedReferenceImageLimit],
    },
    execute: handler,
  };
};
