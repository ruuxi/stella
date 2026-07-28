/**
 * Width thresholds at which the shell changes presentation.
 *
 * The left sidebar is gone, so both remaining thresholds are now plain width
 * comparisons. They used to branch on whether the sidebar was docked (its
 * 252px shifted how much room the center column had left); without it there is
 * only one layout to measure.
 */

const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH = 1120;
const SHELL_DISPLAY_PANEL_TAKEOVER_WIDTH = 720;

export type ShellBreakpointState = {
  hideWorkspaceStrip: boolean;
  displayPanelTakeover: boolean;
};

export const getShellBreakpointState = (
  width: number,
): ShellBreakpointState => ({
  hideWorkspaceStrip:
    width > 0 && width <= SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH,
  displayPanelTakeover:
    width > 0 && width <= SHELL_DISPLAY_PANEL_TAKEOVER_WIDTH,
});
