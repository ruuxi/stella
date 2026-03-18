import { describe, expect, test } from "bun:test";
import { resolveMediaProfile } from "../convex/media_catalog";
import {
  getMediaBillingAdmissionIssue,
  meterCompletedMediaJob,
} from "../convex/media_billing";

describe("media billing metering", () => {
  test("meters text-to-image best from request image count", () => {
    const resolved = resolveMediaProfile("text_to_image", "best");
    expect(resolved).not.toBeNull();

    const billing = meterCompletedMediaJob({
      endpointId: resolved!.profile.endpointId,
      request: {
        capability: "text_to_image",
        profile: "best",
        prompt: "test",
        input: {
          num_images: 2,
          max_images: 3,
        },
      },
      output: { images: [{ url: "https://example.com/a.png" }] },
    });

    expect("supported" in billing).toBe(false);
    if ("supported" in billing) {
      throw new Error("Expected supported billing");
    }
    expect(billing.endpointId).toBe("fal-ai/bytedance/seedream/v5/lite/text-to-image");
    expect(billing.billingUnit).toBe("image");
    expect(billing.quantity).toBe(6);
  });

  test("meters transcription from returned timestamps", () => {
    const resolved = resolveMediaProfile("speech_to_text", "default");
    expect(resolved).not.toBeNull();

    const billing = meterCompletedMediaJob({
      endpointId: resolved!.profile.endpointId,
      request: {
        capability: "speech_to_text",
        profile: "default",
        input: {
          audio_url: "https://example.com/audio.wav",
          keyterms: ["Stella"],
        },
      },
      output: {
        words: [
          { text: "hello", start: 0, end: 1.5 },
          { text: "world", start: 1.5, end: 3 },
        ],
      },
    });

    expect("supported" in billing).toBe(false);
    if ("supported" in billing) {
      throw new Error("Expected supported billing");
    }
    expect(billing.billingUnit).toBe("minute");
    expect(billing.note).toContain("premium");
  });

  test("meters image-to-video motion from request duration", () => {
    const resolved = resolveMediaProfile("image_to_video", "motion");
    expect(resolved).not.toBeNull();

    const billing = meterCompletedMediaJob({
      endpointId: resolved!.profile.endpointId,
      request: {
        capability: "image_to_video",
        profile: "motion",
        prompt: "animate",
        sourceUrl: "https://example.com/image.png",
        input: {
          duration: 6,
        },
      },
      output: { video: { url: "https://example.com/video.mp4" } },
    });

    expect("supported" in billing).toBe(false);
    if ("supported" in billing) {
      throw new Error("Expected supported billing");
    }
    expect(billing.endpointId).toBe("fal-ai/kling-video/v3/pro/motion-control");
    expect(billing.billingUnit).toBe("second");
    expect(billing.quantity).toBe(6);
  });

  test("rejects requests that cannot be billed from actual request/output data", () => {
    const resolved = resolveMediaProfile("sound_effects", "default");
    expect(resolved).not.toBeNull();

    const issue = getMediaBillingAdmissionIssue({
      endpointId: resolved!.profile.endpointId,
      request: {
        capability: "sound_effects",
        profile: "default",
        prompt: "thunder clap",
        input: {},
      },
    });

    expect(issue).toContain("duration_seconds");
  });
});
