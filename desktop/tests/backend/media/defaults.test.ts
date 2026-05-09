import { describe, expect, it } from "bun:test";

import { applyConvenienceInput } from "../../../../backend/convex/http_routes/media";
import { resolveMediaProfile } from "../../../../backend/convex/media_catalog";

const resolve = (capabilityId: string, profileId?: string) => {
  const resolved = resolveMediaProfile(capabilityId, profileId);
  if (!resolved) {
    throw new Error(`Failed to resolve ${capabilityId}/${profileId ?? "default"}`);
  }
  return resolved;
};

describe("media defaults", () => {
  it("defaults text-to-image requests to low quality", () => {
    const resolved = resolve("text_to_image", "best");

    const input = applyConvenienceInput({
      capability: resolved.capability,
      profile: resolved.profile,
      input: {},
      prompt: "a small cabin at sunrise",
    });

    expect(input.quality).toBe("low");
  });

  it("defaults GPT Image 2 text-to-image requests to automatic image size", () => {
    const resolved = resolve("text_to_image", "best");

    const input = applyConvenienceInput({
      capability: resolved.capability,
      profile: resolved.profile,
      input: {},
      prompt: "a small cabin at sunrise",
    });

    expect(input.image_size).toBe("auto");
  });

  it("preserves an explicit client image size override", () => {
    const resolved = resolve("text_to_image", "best");

    const input = applyConvenienceInput({
      capability: resolved.capability,
      profile: resolved.profile,
      input: { image_size: { width: 1280, height: 720 } },
      prompt: "a small cabin at sunrise",
    });

    expect(input.image_size).toEqual({ width: 1280, height: 720 });
  });

  it("uses aspect ratio presets instead of the automatic image size default", () => {
    const resolved = resolve("text_to_image", "best");

    const input = applyConvenienceInput({
      capability: resolved.capability,
      profile: resolved.profile,
      input: {},
      prompt: "a small cabin at sunrise",
      aspectRatio: "16:9",
    });

    expect(input.image_size).toEqual({ width: 1280, height: 720 });
  });

  it("preserves an explicit client quality override", () => {
    const resolved = resolve("text_to_image", "best");

    const input = applyConvenienceInput({
      capability: resolved.capability,
      profile: resolved.profile,
      input: { quality: "medium" },
      prompt: "a small cabin at sunrise",
    });

    expect(input.quality).toBe("medium");
  });

  it("defaults image edit requests to low quality", () => {
    const resolved = resolve("image_edit");

    const input = applyConvenienceInput({
      capability: resolved.capability,
      profile: resolved.profile,
      input: { image_urls: ["https://example.com/input.png"] },
      prompt: "make the background blue",
    });

    expect(input.quality).toBe("low");
  });
});
