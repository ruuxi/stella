export type MediaProvider = "fal" | "google_lyria";

export type MediaProfile = {
  id: string;
  name: string;
  description: string;
  provider: MediaProvider;
  endpointId: string;
  docsUrl: string;
  isDefault?: boolean;
};

export type MediaCapability = {
  id: string;
  name: string;
  description: string;
  category: "audio" | "image" | "video" | "3d" | "analysis";
  promptKey?: string;
  sourceUrlKey?: string;
  requiresSourceUrl?: boolean;
  supportsAspectRatio?: boolean;
  inputHints: string[];
  outputHints: string[];
  profiles: MediaProfile[];
};

const FAL_MODEL_BASE = "https://fal.ai/models";

const falModelUrl = (endpointId: string): string =>
  `${FAL_MODEL_BASE}/${endpointId}/api`;

export const MEDIA_CAPABILITIES: MediaCapability[] = [
  {
    id: "speech_to_text",
    name: "Speech To Text",
    description: "Transcribe spoken audio into text.",
    category: "audio",
    sourceUrlKey: "audio_url",
    inputHints: ["audio_url"],
    outputHints: ["text", "segments", "language"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "Balanced speech transcription via ElevenLabs Scribe v2.",
        provider: "fal",
        endpointId: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
        docsUrl: falModelUrl("fal-ai/elevenlabs/speech-to-text/scribe-v2"),
        isDefault: true,
      },
    ],
  },
  {
    id: "sound_effects",
    name: "Sound Effects",
    description: "Generate Foley and sound effects from text.",
    category: "audio",
    promptKey: "text",
    inputHints: ["text", "duration_seconds"],
    outputHints: ["audio file URL"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "ElevenLabs sound effects generation.",
        provider: "fal",
        endpointId: "fal-ai/elevenlabs/sound-effects/v2",
        docsUrl: falModelUrl("fal-ai/elevenlabs/sound-effects/v2"),
        isDefault: true,
      },
    ],
  },
  {
    id: "text_to_dialogue",
    name: "Text To Dialogue",
    description: "Turn script text into spoken dialogue audio.",
    category: "audio",
    promptKey: "text",
    inputHints: ["text", "voice settings"],
    outputHints: ["audio file URL"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "ElevenLabs dialogue generation with Eleven v3.",
        provider: "fal",
        endpointId: "fal-ai/elevenlabs/text-to-dialogue/eleven-v3",
        docsUrl: falModelUrl("fal-ai/elevenlabs/text-to-dialogue/eleven-v3"),
        isDefault: true,
      },
    ],
  },
  {
    id: "text_to_music",
    name: "Text To Music",
    description: "Generate short music clips from weighted text prompts.",
    category: "audio",
    promptKey: "prompt",
    inputHints: [
      "prompt",
      "weightedPrompts",
      "musicGenerationConfig",
      "promptLabel",
      "musicGenerationMode (VOCALIZATION for sung elements)",
    ],
    outputHints: ["audio file"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "Google Lyria 3 Pro preview music generation.",
        provider: "google_lyria",
        endpointId: "google/lyria-3-pro-preview",
        docsUrl: "https://ai.google.dev/gemini-api/docs/music-generation",
        isDefault: true,
      },
    ],
  },
  {
    id: "text_to_image",
    name: "Text To Image",
    description: "Generate still images from text prompts.",
    category: "image",
    promptKey: "prompt",
    supportsAspectRatio: true,
    inputHints: [
      "prompt",
      "aspectRatio (mapped to image_size)",
      "quality (low | medium | high)",
      "num_images (1-4)",
      "output_format (png | jpeg | webp)",
    ],
    outputHints: ["image URLs"],
    profiles: [
      {
        id: "best",
        name: "Best",
        description:
          "OpenAI GPT Image 2 — photorealistic generation with pixel-accurate text rendering.",
        provider: "fal",
        endpointId: "openai/gpt-image-2",
        docsUrl: falModelUrl("openai/gpt-image-2"),
        isDefault: true,
      },
      {
        id: "fast",
        name: "Fast",
        description: "Faster text-to-image generation with Flux Klein 9B.",
        provider: "fal",
        endpointId: "fal-ai/flux-2/klein/9b",
        docsUrl: falModelUrl("fal-ai/flux-2/klein/9b"),
      },
    ],
  },
  {
    id: "icon",
    name: "Icon Generator",
    description:
      "Generate icons, logos, thumbnails, and other compact visual assets from text prompts.",
    category: "image",
    promptKey: "prompt",
    inputHints: [
      "prompt",
      "transparent / background style",
      "brand / icon constraints",
      "fixed square output",
    ],
    outputHints: ["image URLs"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description:
          "Fast Flux Turbo generation for icons, logos, and thumbnails.",
        provider: "fal",
        endpointId: "fal-ai/flux-2/turbo",
        docsUrl: falModelUrl("fal-ai/flux-2/turbo"),
        isDefault: true,
      },
    ],
  },
  {
    id: "image_edit",
    name: "Image Edit",
    description: "Edit an existing image with text instructions.",
    category: "image",
    promptKey: "prompt",
    sourceUrlKey: "image_urls",
    requiresSourceUrl: true,
    supportsAspectRatio: true,
    inputHints: [
      "image_urls",
      "prompt",
      "aspectRatio (mapped to image_size; defaults to 'auto')",
      "quality (low | medium | high)",
      "num_images (1-4)",
      "mask_url (optional)",
    ],
    outputHints: ["edited image URLs"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description:
          "OpenAI GPT Image 2 (edit) — fine-grained, mask-aware edits with natural-language instructions.",
        provider: "fal",
        endpointId: "openai/gpt-image-2/edit",
        docsUrl: falModelUrl("openai/gpt-image-2/edit"),
        isDefault: true,
      },
      {
        id: "fast",
        name: "Fast",
        description:
          "OpenAI GPT Image 2 (edit) with low quality and automatic image sizing for faster iterations.",
        provider: "fal",
        endpointId: "openai/gpt-image-2/edit",
        docsUrl: falModelUrl("openai/gpt-image-2/edit"),
      },
    ],
  },
  {
    id: "audio_visual_separate",
    name: "Audio Visual Separate",
    description:
      "Separate or isolate audio using the visual track for guidance.",
    category: "analysis",
    inputHints: ["video_url", "audio_url", "separation controls"],
    outputHints: ["separated stems / tracks"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "SAM Audio visual separation.",
        provider: "fal",
        endpointId: "fal-ai/sam-audio/visual-separate",
        docsUrl: falModelUrl("fal-ai/sam-audio/visual-separate"),
        isDefault: true,
      },
    ],
  },
  {
    id: "text_to_video",
    name: "Text To Video",
    description: "Generate a video from a text prompt.",
    category: "video",
    promptKey: "prompt",
    supportsAspectRatio: true,
    inputHints: [
      "prompt",
      "aspectRatio",
      "duration (auto | 4-15 seconds)",
      "resolution (480p | 720p)",
      "generate_audio",
    ],
    outputHints: ["video URL"],
    profiles: [
      {
        id: "fast",
        name: "Fast",
        description: "Seedance 2.0 Fast text-to-video generation.",
        provider: "fal",
        endpointId: "bytedance/seedance-2.0/fast/text-to-video",
        docsUrl: falModelUrl("bytedance/seedance-2.0/fast/text-to-video"),
        isDefault: true,
      },
    ],
  },
  {
    id: "image_to_video",
    name: "Image To Video",
    description: "Animate a still image into a generated video.",
    category: "video",
    promptKey: "prompt",
    sourceUrlKey: "image_url",
    requiresSourceUrl: true,
    supportsAspectRatio: true,
    inputHints: [
      "image_url",
      "prompt",
      "aspectRatio",
      "duration",
      "camera / motion controls",
    ],
    outputHints: ["video URL"],
    profiles: [
      {
        id: "fast",
        name: "Fast",
        description: "Seedance 2.0 Fast image-to-video generation.",
        provider: "fal",
        endpointId: "bytedance/seedance-2.0/fast/image-to-video",
        docsUrl: falModelUrl("bytedance/seedance-2.0/fast/image-to-video"),
        isDefault: true,
      },
    ],
  },
  {
    id: "video_extend",
    name: "Video Extend",
    description: "Continue an existing video clip using a reference prompt.",
    category: "video",
    promptKey: "prompt",
    sourceUrlKey: "video_urls",
    requiresSourceUrl: true,
    supportsAspectRatio: true,
    inputHints: [
      "video_urls",
      "prompt",
      "aspectRatio",
      "duration (auto | 4-15 seconds)",
      "resolution (480p | 720p)",
      "generate_audio",
    ],
    outputHints: ["extended video URL"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "Seedance 2.0 Fast reference-to-video generation.",
        provider: "fal",
        endpointId: "bytedance/seedance-2.0/fast/reference-to-video",
        docsUrl: falModelUrl("bytedance/seedance-2.0/fast/reference-to-video"),
        isDefault: true,
      },
    ],
  },
  {
    id: "video_to_video",
    name: "Video To Video",
    description: "Transform an input video into a new output video.",
    category: "video",
    promptKey: "prompt",
    sourceUrlKey: "video_urls",
    requiresSourceUrl: true,
    supportsAspectRatio: true,
    inputHints: [
      "video_urls",
      "prompt",
      "aspectRatio",
      "duration (auto | 4-15 seconds)",
      "resolution (480p | 720p)",
      "generate_audio",
    ],
    outputHints: ["video URL"],
    profiles: [
      {
        id: "fast",
        name: "Fast",
        description: "Seedance 2.0 Fast reference-to-video generation.",
        provider: "fal",
        endpointId: "bytedance/seedance-2.0/fast/reference-to-video",
        docsUrl: falModelUrl("bytedance/seedance-2.0/fast/reference-to-video"),
        isDefault: true,
      },
    ],
  },
  {
    id: "text_to_3d",
    name: "Text To 3D",
    description: "Generate a 3D asset from text or reference inputs.",
    category: "3d",
    promptKey: "prompt",
    inputHints: ["prompt", "optional image references"],
    outputHints: ["3D asset URLs / mesh files"],
    profiles: [
      {
        id: "default",
        name: "Default",
        description: "Hyper3D Rodin v2 text-to-3D generation.",
        provider: "fal",
        endpointId: "fal-ai/hyper3d/rodin/v2",
        docsUrl: falModelUrl("fal-ai/hyper3d/rodin/v2"),
        isDefault: true,
      },
    ],
  },
];

export type MediaCapabilityId = (typeof MEDIA_CAPABILITIES)[number]["id"];

export const listMediaCapabilities = (): MediaCapability[] =>
  MEDIA_CAPABILITIES.map((capability) => ({
    ...capability,
    profiles: capability.profiles.map((profile) => ({ ...profile })),
  }));

export const getMediaCapability = (
  capabilityId: string,
): MediaCapability | null =>
  MEDIA_CAPABILITIES.find((capability) => capability.id === capabilityId) ??
  null;

export const resolveMediaProfile = (
  capabilityId: string,
  profileId?: string | null,
): { capability: MediaCapability; profile: MediaProfile } | null => {
  const capability = getMediaCapability(capabilityId);
  if (!capability) {
    return null;
  }

  const normalizedProfile = profileId?.trim().toLowerCase();
  if (normalizedProfile) {
    const match = capability.profiles.find(
      (profile) => profile.id === normalizedProfile,
    );
    if (!match) {
      return null;
    }
    return { capability, profile: match };
  }

  const defaultProfile =
    capability.profiles.find((profile) => profile.isDefault) ??
    capability.profiles[0];
  if (!defaultProfile) {
    return null;
  }

  return { capability, profile: defaultProfile };
};
