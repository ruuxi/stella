import { describe, expect, it } from "vitest";
import {
  sanitizeAttachmentImageUrl,
  sanitizeCanvasAppUrl,
  sanitizeExternalLinkUrl,
} from "./url-safety";

describe("url-safety", () => {
  it("allows http/https external links", () => {
    expect(sanitizeExternalLinkUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeExternalLinkUrl("http://localhost:5714")).toBe("http://localhost:5714");
  });

  it("blocks non-http protocols for external links", () => {
    expect(sanitizeExternalLinkUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeExternalLinkUrl("data:text/html,hi")).toBeNull();
  });

  it("allows supported image protocols", () => {
    expect(sanitizeAttachmentImageUrl("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
    expect(sanitizeAttachmentImageUrl("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
    expect(sanitizeAttachmentImageUrl("blob:https://example.com/abc")).toBe(
      "blob:https://example.com/abc",
    );
  });

  it("blocks unsafe attachment image protocols", () => {
    expect(sanitizeAttachmentImageUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeAttachmentImageUrl("ftp://example.com/file.png")).toBeNull();
  });

  it("reuses external-link policy for canvas URLs", () => {
    expect(sanitizeCanvasAppUrl("https://mini-app.example")).toBe("https://mini-app.example");
    expect(sanitizeCanvasAppUrl("file:///tmp/app")).toBeNull();
  });
});
