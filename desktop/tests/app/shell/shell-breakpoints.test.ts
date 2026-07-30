import { describe, expect, it } from "vitest";
import {
  getShellBreakpointState,
  shellBreakpointStore,
} from "@/shell/shell-breakpoints";

// The left sidebar is gone, so both thresholds are plain width comparisons.
// They previously branched on whether the sidebar was docked.
describe("shell breakpoints", () => {
  it("keeps the display panel available after the workspace strip breakpoint", () => {
    expect(getShellBreakpointState(1120)).toMatchObject({
      hideWorkspaceStrip: true,
      displayPanelTakeover: false,
    });
    expect(getShellBreakpointState(1121).hideWorkspaceStrip).toBe(false);
  });

  it("turns the display panel into a full-view takeover at its pressure point", () => {
    expect(getShellBreakpointState(721).displayPanelTakeover).toBe(false);
    expect(getShellBreakpointState(720)).toMatchObject({
      displayPanelTakeover: true,
      hideWorkspaceStrip: true,
    });
  });

  it("treats a zero width as un-measured and hides nothing", () => {
    expect(getShellBreakpointState(0)).toMatchObject({
      hideWorkspaceStrip: false,
      displayPanelTakeover: false,
    });
  });

  it("shares the measured shell breakpoint with composer chrome", () => {
    shellBreakpointStore.setWidth(1120);
    expect(shellBreakpointStore.getSnapshot()).toMatchObject({
      hideWorkspaceStrip: true,
      displayPanelTakeover: false,
    });

    shellBreakpointStore.setWidth(1121);
    expect(shellBreakpointStore.getSnapshot().hideWorkspaceStrip).toBe(false);
  });
});
