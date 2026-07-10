import { describe, expect, it } from "vitest";
import { classifyCanvasNavigation } from "@/shell/display/canvas-tab/canvas-navigation";

describe("canvas navigation policy", () => {
  it("keeps fragments inside the document", () => {
    expect(classifyCanvasNavigation("#details")).toEqual({
      kind: "anchor",
      fragment: "details",
    });
  });

  it.each(["https://example.com/path", "http://example.com/"])(
    "opens absolute web URL externally: %s",
    (href) =>
      expect(classifyCanvasNavigation(href)).toMatchObject({
        kind: "external",
      }),
  );

  it.each([
    "next.html",
    "/docs/page",
    "mailto:user@example.com",
    "javascript:void(0)",
  ])("blocks unsupported canvas navigation: %s", (href) =>
    expect(classifyCanvasNavigation(href)).toEqual({ kind: "blocked" }),
  );
});
