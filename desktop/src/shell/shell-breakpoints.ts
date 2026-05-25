import {
  DISPLAY_MAIN_CONTENT_MIN_WIDTH,
  DISPLAY_PANEL_MIN_WIDTH,
} from "@/shell/display/tab-store";

const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH = 1120;

export type ShellBreakpointState = {
  hideWorkspaceStrip: boolean;
  hideDisplayPanel: boolean;
};

export const getShellBreakpointState = (width: number): ShellBreakpointState => {
  const displayPanelMinimumWindowWidth =
    DISPLAY_MAIN_CONTENT_MIN_WIDTH + DISPLAY_PANEL_MIN_WIDTH;

  return {
    hideWorkspaceStrip:
      width > 0 && width <= SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH,
    hideDisplayPanel: width > 0 && width < displayPanelMinimumWindowWidth,
  };
};
