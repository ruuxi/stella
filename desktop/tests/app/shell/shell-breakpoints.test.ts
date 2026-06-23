import { describe, expect, it } from "vitest";
import { getShellBreakpointState } from "@/shell/shell-breakpoints";

describe("shell breakpoints", () => {
  it("keeps the display panel available after the workspace strip breakpoint", () => {
    expect(getShellBreakpointState(1130, true)).toMatchObject({
      hideWorkspaceStrip: true,
      hideDisplayPanel: false,
      hideLeftSidebar: false,
    });
    expect(getShellBreakpointState(1131, true).hideWorkspaceStrip).toBe(false);
  });

  it("hides the display panel at the Codex right-panel pressure point when the left sidebar is docked", () => {
    expect(getShellBreakpointState(961, true).hideDisplayPanel).toBe(false);
    expect(getShellBreakpointState(960, true)).toMatchObject({
      hideDisplayPanel: true,
      hideLeftSidebar: false,
    });
  });

  it("keeps the display panel longer when the left sidebar is hidden", () => {
    expect(getShellBreakpointState(721, false).hideDisplayPanel).toBe(false);
    expect(getShellBreakpointState(720, false)).toMatchObject({
      hideDisplayPanel: true,
      hideWorkspaceStrip: true,
      hideLeftSidebar: true,
    });
  });

  it("auto-hides the left sidebar at the Codex narrow breakpoint", () => {
    expect(getShellBreakpointState(721, true).hideLeftSidebar).toBe(false);
    expect(getShellBreakpointState(720, true).hideLeftSidebar).toBe(true);
  });
});
