import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceStripOpenPanels,
  type WorkspaceStripOpenPanels,
  type WorkspaceStripPanelMeasurements,
} from "@/app/chat/chat-workspace-strip-layout";

const availablePanels = ["open", "activity", "files", "schedule"] as const;

const measurements: WorkspaceStripPanelMeasurements = {
  open: { collapsedHeight: 36, expandedHeight: 96 },
  activity: { collapsedHeight: 36, expandedHeight: 120 },
  files: { collapsedHeight: 36, expandedHeight: 110 },
  schedule: { collapsedHeight: 36, expandedHeight: 100 },
};

const allOpen: WorkspaceStripOpenPanels = {
  open: true,
  activity: true,
  files: true,
  schedule: true,
};

const resolve = (
  openPanels: WorkspaceStripOpenPanels,
  availableHeight: number,
  justOpened: keyof WorkspaceStripOpenPanels | null = null,
) =>
  resolveWorkspaceStripOpenPanels({
    availableHeight,
    availablePanels,
    gapPx: 10,
    justOpened,
    measurements,
    openPanels,
  });

describe("chat workspace strip layout", () => {
  it("keeps every requested panel open when the stack fits", () => {
    expect(resolve(allOpen, 500)).toEqual(allOpen);
  });

  it("auto-closes the lowest open panel on initial fit pressure", () => {
    expect(resolve(allOpen, 400)).toEqual({
      open: true,
      activity: true,
      files: true,
      schedule: false,
    });
  });

  it("closes multiple panels in one resolution when one demotion is not enough", () => {
    expect(resolve(allOpen, 300)).toEqual({
      open: true,
      activity: false,
      files: false,
      schedule: false,
    });
  });

  it("keeps the panel the user just opened and demotes the lowest other panel", () => {
    expect(resolve(allOpen, 400, "files")).toEqual({
      open: true,
      activity: true,
      files: true,
      schedule: false,
    });
  });

  it("does not preemptively close another panel when the newly opened panel fits", () => {
    expect(resolve(allOpen, 500, "schedule")).toEqual(allOpen);
  });

  it("never reopens a panel just because more height is available", () => {
    const current = {
      open: true,
      activity: true,
      files: true,
      schedule: false,
    };

    expect(resolve(current, 900)).toEqual(current);
  });
});
