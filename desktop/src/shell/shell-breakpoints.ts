import {
  DISPLAY_MAIN_CONTENT_MIN_WIDTH,
  DISPLAY_PANEL_MIN_WIDTH,
} from "@/shell/display/tab-store";

const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITH_SIDEBAR = 1280;
const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITHOUT_SIDEBAR = 1120;
const SHELL_LEFT_SIDEBAR_AUTO_HIDE_WIDTH = 720;
const SHELL_LEFT_SIDEBAR_WIDTH = 180;

export type ShellBreakpointState = {
  hideLeftSidebar: boolean;
  hideWorkspaceStrip: boolean;
  hideDisplayPanel: boolean;
};

export const getShellBreakpointState = (
  width: number,
  userSidebarVisible = true,
): ShellBreakpointState => {
  const hideLeftSidebar =
    width > 0 && width <= SHELL_LEFT_SIDEBAR_AUTO_HIDE_WIDTH;
  const leftSidebarVisible = userSidebarVisible && !hideLeftSidebar;
  const workspaceStripBreakpoint = leftSidebarVisible
    ? SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITH_SIDEBAR
    : SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITHOUT_SIDEBAR;
  const displayPanelMinimumWindowWidth =
    DISPLAY_MAIN_CONTENT_MIN_WIDTH +
    DISPLAY_PANEL_MIN_WIDTH +
    (leftSidebarVisible ? SHELL_LEFT_SIDEBAR_WIDTH : 0);

  return {
    hideLeftSidebar,
    hideWorkspaceStrip: width > 0 && width <= workspaceStripBreakpoint,
    hideDisplayPanel: width > 0 && width < displayPanelMinimumWindowWidth,
  };
};
