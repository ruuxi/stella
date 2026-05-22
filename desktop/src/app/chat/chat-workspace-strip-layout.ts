export const WORKSPACE_STRIP_PANEL_IDS = [
  "open",
  "activity",
  "files",
  "schedule",
] as const;

export type WorkspaceStripPanelId = (typeof WORKSPACE_STRIP_PANEL_IDS)[number];

export type WorkspaceStripOpenPanels = Record<WorkspaceStripPanelId, boolean>;

export type WorkspaceStripPanelMeasurement = {
  collapsedHeight: number;
  expandedHeight: number;
};

export type WorkspaceStripPanelMeasurements = Partial<
  Record<WorkspaceStripPanelId, WorkspaceStripPanelMeasurement>
>;

export const DEFAULT_WORKSPACE_STRIP_OPEN_PANELS: WorkspaceStripOpenPanels = {
  open: true,
  activity: true,
  files: true,
  schedule: true,
};

export const WORKSPACE_STRIP_CARD_GAP_PX = 16;

const closePriority = [...WORKSPACE_STRIP_PANEL_IDS].reverse();

export const areWorkspaceStripOpenPanelsEqual = (
  a: WorkspaceStripOpenPanels,
  b: WorkspaceStripOpenPanels,
): boolean => WORKSPACE_STRIP_PANEL_IDS.every((id) => a[id] === b[id]);

export const measureWorkspaceStripHeight = ({
  availablePanels,
  gapPx = WORKSPACE_STRIP_CARD_GAP_PX,
  measurements,
  openPanels,
}: {
  availablePanels: readonly WorkspaceStripPanelId[];
  gapPx?: number;
  measurements: WorkspaceStripPanelMeasurements;
  openPanels: WorkspaceStripOpenPanels;
}): number | null => {
  let height = 0;

  for (const panelId of availablePanels) {
    const measurement = measurements[panelId];
    if (!measurement) return null;
    height += openPanels[panelId]
      ? measurement.expandedHeight
      : measurement.collapsedHeight;
  }

  if (availablePanels.length > 1) {
    height += (availablePanels.length - 1) * gapPx;
  }

  return height;
};

const fitsWithinHeight = ({
  availableHeight,
  availablePanels,
  gapPx,
  measurements,
  openPanels,
}: {
  availableHeight: number;
  availablePanels: readonly WorkspaceStripPanelId[];
  gapPx: number;
  measurements: WorkspaceStripPanelMeasurements;
  openPanels: WorkspaceStripOpenPanels;
}): boolean => {
  const height = measureWorkspaceStripHeight({
    availablePanels,
    gapPx,
    measurements,
    openPanels,
  });
  return height === null || height <= availableHeight + 1;
};

export const resolveWorkspaceStripOpenPanels = ({
  availableHeight,
  availablePanels,
  gapPx = WORKSPACE_STRIP_CARD_GAP_PX,
  justOpened = null,
  measurements,
  openPanels,
}: {
  availableHeight: number;
  availablePanels: readonly WorkspaceStripPanelId[];
  gapPx?: number;
  justOpened?: WorkspaceStripPanelId | null;
  measurements: WorkspaceStripPanelMeasurements;
  openPanels: WorkspaceStripOpenPanels;
}): WorkspaceStripOpenPanels => {
  if (availableHeight <= 0) return openPanels;

  const next = { ...openPanels };

  if (
    fitsWithinHeight({
      availableHeight,
      availablePanels,
      gapPx,
      measurements,
      openPanels: next,
    })
  ) {
    return next;
  }

  for (const panelId of closePriority) {
    if (panelId === justOpened || !availablePanels.includes(panelId)) continue;
    if (!next[panelId]) continue;

    next[panelId] = false;

    if (
      fitsWithinHeight({
        availableHeight,
        availablePanels,
        gapPx,
        measurements,
        openPanels: next,
      })
    ) {
      break;
    }
  }

  return next;
};
