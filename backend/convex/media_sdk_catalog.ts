import type {
  MediaDocsService,
  MediaServiceDefinition,
} from "./media_sdk_types";

const FAL_DOCS_BASE = "https://fal.ai/models";

const createFalService = (
  id: string,
  args: {
    name: string;
    description: string;
    category: MediaServiceDefinition["category"];
    inputModes: string[];
    outputModes: string[];
    path: string;
  },
): MediaServiceDefinition => ({
  id,
  name: args.name,
  description: args.description,
  category: args.category,
  transport: "fal_queue",
  docsUrl: `${FAL_DOCS_BASE}/${args.path}/api`,
  inputModes: args.inputModes,
  outputModes: args.outputModes,
  async: true,
  hiddenUpstreamId: args.path,
});

export const MEDIA_SDK_VERSION = "2026-03-15";
export const MEDIA_SDK_BASE_PATH = "/api/media/v1";
export const MEDIA_SDK_DOCS_PATH = `${MEDIA_SDK_BASE_PATH}/sdk`;
export const MEDIA_SDK_DOCS_MARKDOWN_PATH = `${MEDIA_SDK_BASE_PATH}/sdk.md`;
export const MEDIA_SDK_JOBS_PATH = `${MEDIA_SDK_BASE_PATH}/jobs`;
export const MEDIA_SDK_JOB_STATUS_PATH = `${MEDIA_SDK_JOBS_PATH}/status`;
export const MEDIA_SDK_JOB_RESULT_PATH = `${MEDIA_SDK_JOBS_PATH}/result`;
export const MEDIA_SDK_JOB_CANCEL_PATH = `${MEDIA_SDK_JOBS_PATH}/cancel`;

const MEDIA_SERVICE_DEFINITIONS = [
  createFalService("speech-to-text", {
    name: "Speech To Text",
    description: "Transcribe spoken audio into text.",
    category: "audio",
    inputModes: ["audio"],
    outputModes: ["text"],
    path: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
  }),
  createFalService("sound-effects", {
    name: "Sound Effects",
    description: "Generate sound effects from text prompts.",
    category: "audio",
    inputModes: ["text"],
    outputModes: ["audio"],
    path: "fal-ai/elevenlabs/sound-effects/v2",
  }),
  createFalService("dialogue", {
    name: "Dialogue",
    description: "Generate spoken dialogue audio from text.",
    category: "audio",
    inputModes: ["text"],
    outputModes: ["audio"],
    path: "fal-ai/elevenlabs/text-to-dialogue/eleven-v3",
  }),
  createFalService("text-to-image", {
    name: "Text To Image",
    description: "Generate polished still images from prompts.",
    category: "image",
    inputModes: ["text"],
    outputModes: ["image"],
    path: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
  }),
  createFalService("image", {
    name: "Image",
    description: "Fast general image generation.",
    category: "image",
    inputModes: ["text"],
    outputModes: ["image"],
    path: "fal-ai/flux-2/klein/9b",
  }),
  createFalService("image-edit", {
    name: "Image Edit",
    description: "Edit an existing image using text instructions.",
    category: "image",
    inputModes: ["image", "text"],
    outputModes: ["image"],
    path: "fal-ai/flux-2/klein/9b/edit",
  }),
  createFalService("image-realtime", {
    name: "Image Realtime",
    description: "Fast iterative image generation for realtime workflows.",
    category: "image",
    inputModes: ["text"],
    outputModes: ["image"],
    path: "fal-ai/flux-2/klein/realtime",
  }),
  createFalService("audio-visual-separation", {
    name: "Audio Visual Separation",
    description: "Separate audio sources using video context.",
    category: "audio",
    inputModes: ["audio", "video"],
    outputModes: ["audio"],
    path: "fal-ai/sam-audio/visual-separate",
  }),
  createFalService("image-to-video", {
    name: "Image To Video",
    description: "Animate a still image into a video clip.",
    category: "video",
    inputModes: ["image", "text"],
    outputModes: ["video"],
    path: "fal-ai/kling-video/v3/pro/motion-control",
  }),
  createFalService("video-depth", {
    name: "Video Depth",
    description: "Estimate depth information for a video.",
    category: "video",
    inputModes: ["video"],
    outputModes: ["video", "json"],
    path: "fal-ai/depth-anything-video",
  }),
  createFalService("extend-video", {
    name: "Extend Video",
    description: "Extend an existing video clip.",
    category: "video",
    inputModes: ["video", "text"],
    outputModes: ["video"],
    path: "fal-ai/ltx-2.3/extend-video",
  }),
  createFalService("video-to-video", {
    name: "Video To Video",
    description: "Transform an input video while preserving reference structure.",
    category: "video",
    inputModes: ["video", "text"],
    outputModes: ["video"],
    path: "fal-ai/kling-video/o3/pro/video-to-video/reference",
  }),
  createFalService("video-edit", {
    name: "Video Edit",
    description: "Edit a video clip with text-guided changes.",
    category: "video",
    inputModes: ["video", "text"],
    outputModes: ["video"],
    path: "xai/grok-imagine-video/edit-video",
  }),
  createFalService("text-to-3d", {
    name: "Text To 3D",
    description: "Generate 3D assets from prompts and references.",
    category: "3d",
    inputModes: ["text", "image"],
    outputModes: ["3d"],
    path: "fal-ai/hyper3d/rodin/v2",
  }),
  {
    id: "music",
    name: "Music",
    description: "Issue a Lyria client session key for realtime music generation.",
    category: "audio",
    transport: "music_api_key",
    inputModes: [],
    outputModes: ["api-key"],
    async: false,
  },
  {
    id: "llm",
    name: "LLM",
    description: "Text chat completion with simple best or fast routing.",
    category: "llm",
    transport: "stella_chat",
    inputModes: ["text"],
    outputModes: ["text", "json"],
    async: false,
    llmVariants: ["best", "fast"],
  },
  {
    id: "media-llm",
    name: "Media LLM",
    description: "Multimodal chat completion for text output from image, audio, or video inputs.",
    category: "llm",
    transport: "stella_chat",
    inputModes: ["text", "image", "audio", "video"],
    outputModes: ["text", "json"],
    async: false,
  },
] as const satisfies readonly MediaServiceDefinition[];

export const MEDIA_SERVICE_CATALOG = Object.freeze(
  Object.fromEntries(
    MEDIA_SERVICE_DEFINITIONS.map((service) => [service.id, service]),
  ) as Record<string, MediaServiceDefinition>,
);

export const listMediaServices = (): MediaDocsService[] =>
  MEDIA_SERVICE_DEFINITIONS.map((service) => {
    const copy = { ...service } as Record<string, unknown>;
    delete copy.hiddenUpstreamId;
    return copy as MediaDocsService;
  });

export const getMediaService = (
  serviceId: string,
): MediaServiceDefinition | undefined => MEDIA_SERVICE_CATALOG[serviceId];
