import { describe, expect, it } from "vitest";
import { getShellBreakpointState } from "@/shell/shell-breakpoints";

describe("shell breakpoints", () => {
  it("keeps the display panel available after the workspace strip breakpoint", () => {
    expect(getShellBreakpointState(1200, true)).toMatchObject({
      hideWorkspaceStrip: true,
      hideDisplayPanel: false,
    });
  });

  it("hides the display panel only after the panel minimum can no longer fit beside main content", () => {
    expect(getShellBreakpointState(900, true).hideDisplayPanel).toBe(false);
    expect(getShellBreakpointState(899, true).hideDisplayPanel).toBe(true);
  });

  it("uses the narrower display-panel breakpoint when the left sidebar is hidden", () => {
    expect(getShellBreakpointState(720, false)).toMatchObject({
      hideDisplayPanel: false,
      hideWorkspaceStrip: true,
    });
    expect(getShellBreakpointState(719, false).hideDisplayPanel).toBe(true);
  });
});
