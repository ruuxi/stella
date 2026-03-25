import { describe, expect, test } from "bun:test";
import {
  getMediaCapability,
  listMediaCapabilities,
  resolveMediaProfile,
} from "../convex/media_catalog";
import {
  applyConvenienceInput,
  describeCapabilityValidation,
  MEDIA_DOCS_PATH,
  MEDIA_CAPABILITIES_PATH,
  MEDIA_FAL_WEBHOOK_PATH,
  MEDIA_GENERATE_PATH,
  MEDIA_REALTIME_SESSION_PATH,
  validateCapabilityRequest,
} from "../convex/http_routes/media";
import {
  STELLA_BEST_MODEL,
  STELLA_CHEAP_MODEL,
  STELLA_FAST_MODEL,
  STELLA_MEDIA_MODEL,
  STELLA_SMART_MODEL,
  listStellaCatalogModels,
  resolveStellaModelSelection,
} from "../convex/stella_models";

describe("media api contract", () => {
  test("exposes the canonical submission and webhook routes", () => {
    expect(MEDIA_DOCS_PATH).toBe("/api/media/v1/docs");
    expect(MEDIA_CAPABILITIES_PATH).toBe("/api/media/v1/capabilities");
    expect(MEDIA_GENERATE_PATH).toBe("/api/media/v1/generate");
    expect(MEDIA_REALTIME_SESSION_PATH).toBe("/api/media/v1/realtime/session");
    expect(MEDIA_FAL_WEBHOOK_PATH).toBe("/api/media/v1/webhooks/fal");
  });

  test("contains the requested media capabilities", () => {
    const capabilities = listMediaCapabilities();
    expect(capabilities.map((capability) => capability.id)).toEqual(
      expect.arrayContaining([
        "speech_to_text",
        "sound_effects",
        "text_to_dialogue",
        "text_to_image",
        "icon",
        "image_edit",
        "realtime",
        "audio_visual_separate",
        "image_to_video",
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
    expect(resolveMediaProfile("icon", "default")?.profile.endpointId).toBe(
      "fal-ai/flux-2/turbo",
    );
    expect(resolveMediaProfile("text_to_image", "fast")?.profile.endpointId).toBe(
      "fal-ai/flux-2/klein/9b",
    );
    expect(resolveMediaProfile("image_edit", "default")?.profile.endpointId).toBe(
      "fal-ai/flux-2/klein/9b/edit",
    );
    expect(resolveMediaProfile("realtime", "default")?.profile.endpointId).toBe(
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
    expect(getMediaCapability("text_to_3d")?.requiresSourceUrl).toBeFalsy();
  });

  test("enforces prompt and source URL validation at the backend boundary", () => {
    expect(describeCapabilityValidation("text_to_image")).toEqual({
      requiresPrompt: true,
      requiresSourceUrl: false,
      acceptsBase64Source: false,
      supportsAspectRatio: true,
    });
    expect(describeCapabilityValidation("icon")).toEqual({
      requiresPrompt: true,
      requiresSourceUrl: false,
      acceptsBase64Source: false,
      supportsAspectRatio: false,
    });
    expect(describeCapabilityValidation("image_to_video")).toEqual({
      requiresPrompt: true,
      requiresSourceUrl: true,
      acceptsBase64Source: true,
      supportsAspectRatio: true,
    });
    expect(
      validateCapabilityRequest({
        capabilityId: "text_to_image",
      }),
    ).toBe("prompt is required for this capability");

    expect(
      validateCapabilityRequest({
        capabilityId: "image_to_video",
        prompt: "animate this image",
        sourceUrl: "not-a-url",
      }),
    ).toBe("A valid http(s) sourceUrl or source.base64 input is required for this capability");

    expect(
      validateCapabilityRequest({
        capabilityId: "image_to_video",
        prompt: "animate this image",
        aspectRatio: "16:9",
        source: "data:image/png;base64,aGVsbG8=",
      }),
    ).toBeNull();

    expect(
      validateCapabilityRequest({
        capabilityId: "image_to_video",
        prompt: "animate this image",
        source: {
          mimeType: "",
          base64: "aGVsbG8=",
        },
      }),
    ).toBe("source.mimeType must be a valid MIME type");

    expect(
      validateCapabilityRequest({
        capabilityId: "image_to_video",
        prompt: "animate this image",
        source: {
          mimeType: "image/png",
          base64: "%%%bad%%%",
        },
      }),
    ).toBe("source.base64 must be valid base64");

    expect(
      validateCapabilityRequest({
        capabilityId: "audio_visual_separate",
        sources: {
          video: "data:video/mp4;base64,dm1wNA==",
          audio: "data:audio/wav;base64,YXVkaW8=",
        },
      }),
    ).toBeNull();

    expect(
      validateCapabilityRequest({
        capabilityId: "audio_visual_separate",
        sources: {
          video: "bad-source",
        },
      }),
    ).toBe("sources.video must be a valid http(s) URL or data URI");

    expect(
      validateCapabilityRequest({
        capabilityId: "sound_effects",
        prompt: "thunder clap",
      }),
    ).toBe("duration_seconds is required for this capability");

    expect(
      validateCapabilityRequest({
        capabilityId: "sound_effects",
        prompt: "thunder clap",
        input: { duration_seconds: 4 },
      }),
    ).toBeNull();
  });

  test("locks icon generation to the provider's fixed square image size", () => {
    const capability = getMediaCapability("icon");
    expect(capability).not.toBeNull();
    expect(
      applyConvenienceInput({
        capability: capability!,
        input: {},
        prompt: "minimal app icon for a budgeting assistant",
      }),
    ).toEqual({
      prompt: "minimal app icon for a budgeting assistant",
      image_size: {
        width: 512,
        height: 512,
      },
    });
  });
});

describe("stella llm aliases", () => {
  test("resolves stable cheap, fast, smart, best, and media aliases", () => {
    expect(resolveStellaModelSelection("general", STELLA_CHEAP_MODEL)).toBe(
      "zai/glm-4.7",
    );
    expect(resolveStellaModelSelection("general", STELLA_FAST_MODEL)).toBe(
      "inception/mercury-2",
    );
    expect(resolveStellaModelSelection("general", STELLA_SMART_MODEL)).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(resolveStellaModelSelection("general", STELLA_BEST_MODEL)).toBe(
      "anthropic/claude-opus-4.6",
    );
    expect(resolveStellaModelSelection("general", STELLA_MEDIA_MODEL)).toBe(
      "google/gemini-3-flash-preview",
    );
  });

  test("lists the aliases in the public stella catalog", () => {
    const ids = listStellaCatalogModels().map((model) => model.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "stella/default",
        STELLA_CHEAP_MODEL,
        STELLA_FAST_MODEL,
        STELLA_SMART_MODEL,
        STELLA_BEST_MODEL,
        STELLA_MEDIA_MODEL,
      ]),
    );
  });
});
