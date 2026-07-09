import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES,
  ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES,
  ANTHROPIC_HARD_MAX_EDGE,
  ANTHROPIC_HIGH_RES_MAX_EDGE,
  ANTHROPIC_STANDARD_MAX_EDGE,
  DEFAULT_JPEG_QUALITY,
  GOOGLE_MAX_EDGE,
  isAnthropicStandardTierModel,
  MANY_IMAGE_MAX_EDGE,
  maxInlineImageBase64Bytes,
  OPENAI_MAX_EDGE,
  OPENAI_ORIGINAL_MAX_EDGE,
  resolveImageCaps,
  SAFE_FALLBACK_MAX_BYTES,
  SAFE_FALLBACK_MAX_EDGE,
} from "../../../../runtime/ai/utils/image-caps.js";

describe("resolveImageCaps", () => {
  it("gives Anthropic high-resolution-tier models the 2576px long edge", () => {
    const caps = resolveImageCaps({
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "claude-opus-4-8",
    });
    expect(caps.maxWidth).toBe(ANTHROPIC_HIGH_RES_MAX_EDGE);
    expect(caps.maxHeight).toBe(ANTHROPIC_HIGH_RES_MAX_EDGE);
    expect(caps.jpegQuality).toBe(DEFAULT_JPEG_QUALITY);
    // Direct API: resize target stays a margin under the 10MB hard cap.
    expect(caps.maxBytes).toBeLessThan(ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES);
    expect(caps.maxBytes).toBeGreaterThan(SAFE_FALLBACK_MAX_BYTES);
  });

  it("defaults unknown/newer Anthropic model ids to the high-res tier", () => {
    const caps = resolveImageCaps({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(caps.maxWidth).toBe(ANTHROPIC_HIGH_RES_MAX_EDGE);
  });

  it("drops legacy Anthropic models to the 1568px standard tier", () => {
    const caps = resolveImageCaps({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
    });
    expect(caps.maxWidth).toBe(ANTHROPIC_STANDARD_MAX_EDGE);
  });

  it("uses the 5MB Bedrock/Vertex byte cap for those routes", () => {
    const caps = resolveImageCaps({
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
      modelId: "claude-opus-4-8",
    });
    expect(caps.maxBytes).toBeLessThan(
      ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES,
    );
    expect(maxInlineImageBase64Bytes({ provider: "amazon-bedrock" })).toBe(
      ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES,
    );
  });

  it("caps OpenAI at 2048px (high) and lifts to 6000px for original detail", () => {
    expect(resolveImageCaps({ provider: "openai" }).maxWidth).toBe(
      OPENAI_MAX_EDGE,
    );
    expect(
      resolveImageCaps({ provider: "openai", detailOriginal: true }).maxWidth,
    ).toBe(OPENAI_ORIGINAL_MAX_EDGE);
  });

  it("gives Google Gemini the 3072px ceiling", () => {
    expect(resolveImageCaps({ provider: "google" }).maxWidth).toBe(
      GOOGLE_MAX_EDGE,
    );
  });

  it("falls back to the safe conservative profile for unknown providers", () => {
    const caps = resolveImageCaps({ provider: "some-new-gateway" });
    expect(caps.maxWidth).toBe(SAFE_FALLBACK_MAX_EDGE);
    expect(caps.maxBytes).toBe(SAFE_FALLBACK_MAX_BYTES);
  });

  it("clamps to 2000px when a request carries more than 20 images", () => {
    const caps = resolveImageCaps({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      imageCount: 21,
    });
    expect(caps.maxWidth).toBe(MANY_IMAGE_MAX_EDGE);
  });

  it("keeps original resolution up to the hard ceiling for detail:original", () => {
    const caps = resolveImageCaps({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      detailOriginal: true,
    });
    expect(caps.maxWidth).toBe(ANTHROPIC_HARD_MAX_EDGE);
    expect(caps.maxBytes).toBe(ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES);
  });

  it("resolves the direct-API hard byte cap for Anthropic and unknown routes", () => {
    expect(maxInlineImageBase64Bytes({ provider: "anthropic" })).toBe(
      ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES,
    );
    expect(maxInlineImageBase64Bytes({ provider: "mystery" })).toBe(
      ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES,
    );
  });
});

describe("isAnthropicStandardTierModel", () => {
  it("treats modern Opus/Sonnet families as high-res (not standard)", () => {
    expect(isAnthropicStandardTierModel("claude-opus-4-8")).toBe(false);
    expect(isAnthropicStandardTierModel("claude-sonnet-4-5")).toBe(false);
    expect(isAnthropicStandardTierModel("claude-sonnet-5")).toBe(false);
  });

  it("treats legacy Claude 2.x/3.x families as standard tier", () => {
    expect(isAnthropicStandardTierModel("claude-3-5-sonnet-20241022")).toBe(
      true,
    );
    expect(isAnthropicStandardTierModel("claude-3-opus-20240229")).toBe(true);
    expect(isAnthropicStandardTierModel("claude-2.1")).toBe(true);
  });

  it("defaults an empty id to high-res (non-standard)", () => {
    expect(isAnthropicStandardTierModel("")).toBe(false);
  });
});
