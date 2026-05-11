/**
 * Canonical "create media" action catalog used by the workspace
 * panel's Media tab.
 *
 * Per AGENTS.md, this surface owns the normie-friendly labels
 * (Photo / Edit / Animate / Sound / Voice / 3D); other surfaces
 * (e.g. `MediaStudio`) reuse this list rather than redefining one.
 */
import type { DisplayPayload } from "@/shared/contracts/display-payload";

export type MediaTabItem = {
  id: string;
  asset: Extract<DisplayPayload, { kind: "media" }>["asset"];
  prompt?: string;
  capability?: string;
  createdAt: number;
};

export type MediaActionId =
  | "text_to_image"
  | "text_to_video"
  | "image_edit"
  | "image_to_video"
  | "sound_effects"
  | "text_to_dialogue"
  | "text_to_3d";

export type MediaAssetKind =
  | "image"
  | "video"
  | "audio"
  | "model3d"
  | "download"
  | "text";

export type MediaAction = {
  id: MediaActionId;
  label: string;
  placeholder: string;
  sourceKind?: "image";
};

export const MEDIA_ACTIONS: MediaAction[] = [
  {
    id: "text_to_image",
    label: "Photo",
    placeholder: "Describe a photo to make",
  },
  {
    id: "text_to_video",
    label: "Video",
    placeholder: "Describe a video to make",
  },
  {
    id: "image_edit",
    label: "Edit",
    placeholder: "Describe how to change this image",
    sourceKind: "image",
  },
  {
    id: "image_to_video",
    label: "Animate",
    placeholder: "Describe how it should move",
    sourceKind: "image",
  },
  {
    id: "sound_effects",
    label: "Sound",
    placeholder: "Describe a sound effect",
  },
  {
    id: "text_to_dialogue",
    label: "Voice",
    placeholder: "Type what to say",
  },
  {
    id: "text_to_3d",
    label: "3D",
    placeholder: "Describe a 3D object",
  },
];
