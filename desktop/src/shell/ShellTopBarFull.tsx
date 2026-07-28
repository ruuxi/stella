/**
 * Full-window top bar.
 *
 * Before the shell redesign the full window had no top bar at all — the left
 * sidebar's chrome carried the macOS traffic-light inset, the update pill and
 * the account control, and the only other chrome was a pair of floating edge
 * toggles. With the sidebar gone, this bar takes over that job: it is the one
 * strip that owns the window's drag region, clears the traffic lights, and
 * hosts navigation plus the account/settings entry.
 *
 * The treatment follows Stella v2's: a transparent 38px strip with no border
 * and no backdrop, carrying floating controls. Everything inside carves
 * `no-drag` out of the bar's `drag` region, and the bar is rendered late in the
 * shell tree because `-webkit-app-region` resolves in DOM order rather than by
 * z-index — a control painted above but declared earlier still reads as
 * draggable and swallows its own clicks.
 *
 * Apps are deliberately absent from the nav: they now open inside the right
 * sidebar's Apps section rather than the main content area, so a nav entry
 * pointing at the `/apps` route would compete with the sidebar for the same
 * job. Home is also omitted because its surface is the sidebar's first tab.
 */

import { getPlatform } from "@/platform/electron/platform";
import {
  displayTabs,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import { ShellTopBarPrimaryNav } from "@/shell/sidebar/ShellTopBarNav";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";
import { WindowControls } from "@/shell/WindowControls";
import { PanelRight } from "@/ui/icons";
import "./shell-topbar-full.css";

/**
 * Nav entries the full-window bar suppresses. Apps and Home both live in the
 * right sidebar now.
 */
const OMITTED_NAV_IDS = ["apps", "chat"] as const;

type ShellTopBarFullProps = {
  onSignIn?: () => void;
  onConnect?: () => void;
};

export function ShellTopBarFull({ onSignIn, onConnect }: ShellTopBarFullProps) {
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const panelOpen = useDisplayPanelOpen();

  return (
    <header
      className="shell-topbar-full"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
    >
      <div className="shell-topbar-full__left">
        <ShellTopBarPrimaryNav omitIds={OMITTED_NAV_IDS} />
        <ShellTopBarUpdatePill />
      </div>

      <div className="shell-topbar-full__spacer" aria-hidden="true" />

      <div className="shell-topbar-full__right">
        {/* The panel has no persistent affordance while open — the display
            topbar owns close/expand — so this only offers the "summon"
            direction. */}
        {!panelOpen ? (
          <button
            type="button"
            className="shell-topbar-icon-btn"
            onClick={() => displayTabs.setPanelOpen(true)}
            aria-label="Open panel"
            title="Open panel"
          >
            <PanelRight size={16} strokeWidth={1.75} />
          </button>
        ) : null}

        <ShellTopBarAccount onSignIn={onSignIn} onConnect={onConnect} />

        {isWin ? <WindowControls useWindowsIcons hidden={false} /> : null}
      </div>
    </header>
  );
}
