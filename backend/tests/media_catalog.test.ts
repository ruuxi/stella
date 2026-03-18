import { describe, expect, test } from "bun:test";
import {
  getMediaCapability,
  listMediaCapabilities,
  resolveMediaProfile,
} from "../convex/media_catalog";

describe("media catalog", () => {
  test("lists the expected core capabilities", () => {
    const capabilities = listMediaCapabilities();
    expect(capabilities.some((entry) => entry.id === "text_to_image")).toBe(true);
    expect(capabilities.some((entry) => entry.id === "icon")).toBe(true);
    expect(capabilities.some((entry) => entry.id === "image_edit")).toBe(true);
    expect(capabilities.some((entry) => entry.id === "realtime")).toBe(true);
    expect(capabilities.some((entry) => entry.id === "video_to_video")).toBe(true);
    expect(capabilities.some((entry) => entry.id === "speech_to_text")).toBe(true);
    expect(capabilities.some((entry) => entry.id === "video_depth")).toBe(false);
  });

  test("resolves default and explicit profiles", () => {
    const textToImage = resolveMediaProfile("text_to_image");
    expect(textToImage?.profile.id).toBe("best");

    const icon = resolveMediaProfile("icon");
    expect(icon?.profile.id).toBe("default");

    const imageEdit = resolveMediaProfile("image_edit");
    expect(imageEdit?.profile.id).toBe("default");

    const realtime = resolveMediaProfile("realtime");
    expect(realtime?.profile.id).toBe("default");
  });

  test("exposes convenience metadata for source-based capabilities", () => {
    const videoToVideo = getMediaCapability("video_to_video");
    expect(videoToVideo?.requiresSourceUrl).toBe(true);
    expect(videoToVideo?.sourceUrlKey).toBe("video_url");
  });

  test("returns null for unknown capability or profile", () => {
    expect(resolveMediaProfile("unknown")).toBeNull();
    expect(resolveMediaProfile("text_to_image", "unknown")).toBeNull();
  });
});
