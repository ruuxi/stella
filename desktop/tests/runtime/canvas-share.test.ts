import { describe, expect, it } from "vitest";
import {
  buildCanvasShareUrl,
  isCanvasShareSlug,
  isCanvasShareUrl,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
} from "../../../runtime/contracts/canvas-share";

const BASE = "https://share.example.com";

describe("readCanvasShareBaseUrl", () => {
  it("normalizes and trims trailing slashes", () => {
    expect(readCanvasShareBaseUrl("https://share.example.com/")).toBe(BASE);
    expect(readCanvasShareBaseUrl("  https://share.example.com//  ")).toBe(BASE);
  });

  it("returns null for unset / blank / non-http values", () => {
    expect(readCanvasShareBaseUrl(undefined)).toBeNull();
    expect(readCanvasShareBaseUrl(null)).toBeNull();
    expect(readCanvasShareBaseUrl("")).toBeNull();
    expect(readCanvasShareBaseUrl("   ")).toBeNull();
    expect(readCanvasShareBaseUrl("ftp://share.example.com")).toBeNull();
    expect(readCanvasShareBaseUrl("not a url")).toBeNull();
  });
});

describe("isCanvasShareSlug", () => {
  it("accepts url/file-safe slugs", () => {
    expect(isCanvasShareSlug("abc123")).toBe(true);
    expect(isCanvasShareSlug("my-canvas_01.v2")).toBe(true);
  });

  it("rejects traversal and unsafe characters", () => {
    expect(isCanvasShareSlug("..")).toBe(false);
    expect(isCanvasShareSlug("a/b")).toBe(false);
    expect(isCanvasShareSlug("a b")).toBe(false);
    expect(isCanvasShareSlug("-lead")).toBe(false);
    expect(isCanvasShareSlug("")).toBe(false);
    expect(isCanvasShareSlug(42)).toBe(false);
  });
});

describe("parseCanvasShareSlug", () => {
  it("extracts the slug from a well-formed share URL", () => {
    expect(parseCanvasShareSlug(`${BASE}/c/abc123`, BASE)).toBe("abc123");
    expect(parseCanvasShareSlug(`${BASE}/c/my-canvas_1`, BASE)).toBe(
      "my-canvas_1",
    );
  });

  it("returns null when the base URL is not configured", () => {
    expect(parseCanvasShareSlug(`${BASE}/c/abc123`, null)).toBeNull();
    expect(parseCanvasShareSlug(`${BASE}/c/abc123`, undefined)).toBeNull();
  });

  it("rejects other origins, other paths, and nested segments", () => {
    expect(parseCanvasShareSlug("https://evil.example.com/c/abc", BASE)).toBeNull();
    expect(parseCanvasShareSlug(`${BASE}/x/abc`, BASE)).toBeNull();
    expect(parseCanvasShareSlug(`${BASE}/c/`, BASE)).toBeNull();
    expect(parseCanvasShareSlug(`${BASE}/c/a/b`, BASE)).toBeNull();
    expect(parseCanvasShareSlug(`${BASE}/c/..`, BASE)).toBeNull();
  });

  it("scopes /c/<slug> under a base URL that itself has a sub-path", () => {
    const subBase = "https://host.example.com/app";
    expect(parseCanvasShareSlug(`${subBase}/c/abc`, subBase)).toBe("abc");
    expect(parseCanvasShareSlug("https://host.example.com/c/abc", subBase)).toBeNull();
  });
});

describe("buildCanvasShareUrl / isCanvasShareUrl", () => {
  it("round-trips a slug through build + parse", () => {
    const url = buildCanvasShareUrl(BASE, "abc123");
    expect(url).toBe(`${BASE}/c/abc123`);
    expect(isCanvasShareUrl(url, BASE)).toBe(true);
    expect(parseCanvasShareSlug(url, BASE)).toBe("abc123");
  });

  it("reports non-share URLs as false", () => {
    expect(isCanvasShareUrl("https://share.example.com/about", BASE)).toBe(false);
    expect(isCanvasShareUrl("https://other.example.com/c/abc", BASE)).toBe(false);
  });
});
