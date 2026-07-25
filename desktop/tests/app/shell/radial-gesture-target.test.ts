// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isRadialGestureExempt } from "@/shell/radial/radial-gesture-target";

// The dial claims the right button across the whole shell. Editable text is
// the one place a context menu still earns its keep, so those presses have to
// fall through.
describe("isRadialGestureExempt", () => {
  it("exempts a surface that opted out explicitly", () => {
    const form = document.createElement("form");
    form.dataset.composerContextMenu = "native";
    const child = document.createElement("span");
    form.appendChild(child);

    expect(isRadialGestureExempt(form)).toBe(true);
    expect(isRadialGestureExempt(child)).toBe(true);
  });

  it("exempts editable fields without needing them to be tagged", () => {
    expect(isRadialGestureExempt(document.createElement("input"))).toBe(true);
    expect(isRadialGestureExempt(document.createElement("textarea"))).toBe(
      true,
    );

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isRadialGestureExempt(editable)).toBe(true);
  });

  it("does not exempt an explicitly non-editable region", () => {
    const notEditable = document.createElement("div");
    notEditable.setAttribute("contenteditable", "false");
    expect(isRadialGestureExempt(notEditable)).toBe(false);
  });

  it("claims ordinary shell surface", () => {
    expect(isRadialGestureExempt(document.createElement("div"))).toBe(false);
    expect(isRadialGestureExempt(document.createElement("button"))).toBe(false);
  });

  it("tolerates a non-element target", () => {
    expect(isRadialGestureExempt(null)).toBe(false);
    expect(isRadialGestureExempt(document.createTextNode("x"))).toBe(false);
  });
});
