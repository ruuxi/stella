const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITH_TOPBAR = 1130;
const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITHOUT_TOPBAR = 1120;
const SHELL_TOPBAR_CONTEXT_AUTO_HIDE_WIDTH = 720;
const SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITH_TOPBAR = 900;
const SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITHOUT_TOPBAR = 720;

export type ShellBreakpointState = {
  hideWorkspaceStrip: boolean;
  hideDisplayPanel: boolean;
};

export const getShellBreakpointState = (
  width: number,
  leftSidebarVisible = true,
): ShellBreakpointState => {
  const hideTopbarContext =
    width > 0 && width <= SHELL_TOPBAR_CONTEXT_AUTO_HIDE_WIDTH;
  const visibleTopbarContext = leftSidebarVisible && !hideTopbarContext;
  const workspaceStripBreakpoint = visibleTopbarContext
    ? SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITH_TOPBAR
    : SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH_WITHOUT_TOPBAR;
  const displayPanelMinimumWindowWidth = visibleTopbarContext
    ? SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITH_TOPBAR
    : SHELL_DISPLAY_PANEL_AUTO_HIDE_WIDTH_WITHOUT_TOPBAR;

  return {
    hideWorkspaceStrip: width > 0 && width <= workspaceStripBreakpoint,
    hideDisplayPanel: width > 0 && width < displayPanelMinimumWindowWidth,
  };
};
