import { describe, expect, test } from "bun:test";
import {
  getMediaCapability,
  listMediaCapabilities,
  resolveMediaProfile,
} from "../convex/media_catalog";
import {
  MEDIA_DOCS_PATH,
  MEDIA_SDK_JSON_PATH,
  MEDIA_SDK_MARKDOWN_PATH,
  MEDIA_GENERATE_PATH,
  MEDIA_JOBS_PATH,
} from "../convex/http_routes/media";
import {
  STELLA_BEST_MODEL,
  STELLA_FAST_MODEL,
  STELLA_MEDIA_MODEL,
  listStellaCatalogModels,
  resolveStellaModelSelection,
} from "../convex/stella_models";

describe("media sdk catalog", () => {
  test("exposes the sdk routes", () => {
    expect(MEDIA_DOCS_PATH).toBe("/api/media/v1/docs");
    expect(MEDIA_SDK_JSON_PATH).toBe("/api/media/v1/sdk");
    expect(MEDIA_SDK_MARKDOWN_PATH).toBe("/api/media/v1/sdk.md");
    expect(MEDIA_GENERATE_PATH).toBe("/api/media/v1/generate");
    expect(MEDIA_JOBS_PATH).toBe("/api/media/v1/jobs");
  });

  test("contains the requested media capabilities", () => {
    const capabilities = listMediaCapabilities();
    expect(capabilities.map((capability) => capability.id)).toEqual(
      expect.arrayContaining([
        "speech_to_text",
        "sound_effects",
        "text_to_dialogue",
        "text_to_image",
        "image_edit",
        "audio_visual_separate",
        "image_to_video",
        "video_depth",
        "video_extend",
        "video_to_video",
        "text_to_3d",
      ]),
    );
  });

  test("keeps the expected fal profiles for image and video generation", () => {
    expect(resolveMediaProfile("text_to_image", "best")?.profile.endpointId).toBe(
      "fal-ai/bytedance/seedream/v5/lite/text-to-image",
    );
    expect(resolveMediaProfile("text_to_image", "fast")?.profile.endpointId).toBe(
      "fal-ai/flux-2/klein/9b",
    );
    expect(resolveMediaProfile("image_edit", "fast")?.profile.endpointId).toBe(
      "fal-ai/flux-2/klein/9b/edit",
    );
    expect(resolveMediaProfile("image_edit", "realtime")?.profile.endpointId).toBe(
      "fal-ai/flux-2/klein/realtime",
    );
    expect(resolveMediaProfile("video_to_video", "reference")?.profile.endpointId).toBe(
      "fal-ai/kling-video/o3/pro/video-to-video/reference",
    );
    expect(resolveMediaProfile("video_to_video", "edit")?.profile.endpointId).toBe(
      "xai/grok-imagine-video/edit-video",
    );
  });

  test("marks source-dependent capabilities correctly", () => {
    expect(getMediaCapability("image_to_video")?.requiresSourceUrl).toBe(true);
    expect(getMediaCapability("video_depth")?.requiresSourceUrl).toBe(true);
    expect(getMediaCapability("text_to_3d")?.requiresSourceUrl).toBeFalsy();
  });
});

describe("stella llm aliases", () => {
  test("resolves stable best, fast, and media aliases", () => {
    expect(resolveStellaModelSelection("general", STELLA_BEST_MODEL)).toBe(
      "moonshotai/kimi-k2.5",
    );
    expect(resolveStellaModelSelection("general", STELLA_FAST_MODEL)).toBe(
      "google/gemini-3-flash",
    );
    expect(resolveStellaModelSelection("general", STELLA_MEDIA_MODEL)).toBe(
      "google/gemini-3-flash",
    );
  });

  test("lists the aliases in the public stella catalog", () => {
    const ids = listStellaCatalogModels().map((model) => model.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "stella/default",
        STELLA_BEST_MODEL,
        STELLA_FAST_MODEL,
        STELLA_MEDIA_MODEL,
      ]),
    );
  });
});
