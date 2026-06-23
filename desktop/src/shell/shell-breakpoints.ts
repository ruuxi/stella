const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITH_TOPBAR = 1130;
const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITHOUT_TOPBAR = 1120;
const SHELL_LEFT_SIDEBAR_AUTO_HIDE_WIDTH = 720;
const SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITH_LEFT_SIDEBAR = 960;
const SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITHOUT_LEFT_SIDEBAR = 720;

export type ShellBreakpointState = {
  hideWorkspaceStrip: boolean;
  hideDisplayPanel: boolean;
  hideLeftSidebar: boolean;
};

export const getShellBreakpointState = (
  width: number,
  leftSidebarVisible = true,
): ShellBreakpointState => {
  const hideLeftSidebar =
    width > 0 && width <= SHELL_LEFT_SIDEBAR_AUTO_HIDE_WIDTH;
  const dockedLeftSidebarVisible = leftSidebarVisible && !hideLeftSidebar;
  const workspaceStripBreakpoint = dockedLeftSidebarVisible
    ? SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITH_TOPBAR
    : SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITHOUT_TOPBAR;
  const displayPanelBreakpoint = dockedLeftSidebarVisible
    ? SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITH_LEFT_SIDEBAR
    : SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITHOUT_LEFT_SIDEBAR;

  return {
    hideWorkspaceStrip: width > 0 && width <= workspaceStripBreakpoint,
    hideDisplayPanel: width > 0 && width <= displayPanelBreakpoint,
    hideLeftSidebar,
  };
};
