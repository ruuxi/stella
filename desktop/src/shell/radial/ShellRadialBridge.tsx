/**
 * The shell's end of the right-button radial dial.
 *
 * The dial itself no longer lives in this document. It is painted by the
 * always-on-top overlay window (the same one that hosts the system chord
 * dial) and the whole press-drag-release gesture is captured globally in the
 * main process by uiohook — see `shell-radial-gesture-service`. That
 * architecture is what makes the dial reliable over any content: earlier
 * in-renderer versions lost releases to embedded frames (which own
 * real-input routing once a press or drag involves them) and to window drag
 * regions (which consume events before the page sees them). An overlay
 * window driven by the global hook receives no DOM events and has nothing
 * to lose.
 *
 * What must stay in the renderer are the two things only it can know or do:
 *
 * - `shell-radial:query-press` — whether the pressed point is exempt. The
 *   composer and editable fields keep their native context menu; only the
 *   DOM can see what is under the cursor. A point over an embedded frame
 *   hit-tests to the frame's element here, which is never exempt — exactly
 *   right, artifact and app surfaces are dial territory.
 * - `shell-radial:commit` — applying the selected wedge. Sections route
 *   through `sidebarSections.selectSection`, the same verb the tab rail
 *   uses, so the dial inherits open/switch/close and per-section memory.
 *   The Close wedge is not a section: it just closes the panel.
 *
 * The window-level `contextmenu` suppression also stays here: the dial owns
 * the right button on the shell surface, so the OS menu is suppressed for
 * every press the dial would claim, and allowed through for exempt targets.
 */

import { useEffect, useRef } from "react";
import {
  sidebarSections,
  type SidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";
import { showToast } from "@/ui/toast";
import { isRadialGestureExempt } from "./radial-gesture-target";

/**
 * Wedge index → action, in the shared quadrant order (index 0 upper-right,
 * clockwise). Must match `SHELL_WEDGES` in the overlay's RadialDial — the
 * main process commits by index against that same order.
 */
const WEDGE_ACTIONS: readonly (SidebarSection | "close")[] = [
  "home",
  "files",
  "close",
  "apps",
];

export function ShellRadialBridge() {
  // Whether the main process's global input hook is delivering events.
  // `null` until the first answer arrives; refreshed on window focus because
  // granting accessibility in System Settings and returning to the app is
  // exactly the moment the answer flips.
  const hookLiveRef = useRef<boolean | null>(null);
  const permissionToastShownRef = useRef(false);

  useEffect(() => {
    const shellRadial = window.electronAPI?.shellRadial;

    const refreshHookLiveness = () => {
      void shellRadial?.isGestureHookLive?.().then((live) => {
        hookLiveRef.current = live;
      });
    };
    refreshHookLiveness();
    window.addEventListener("focus", refreshHookLiveness);

    // The dial claims the right button across the shell surface, so the
    // context menu the OS would raise on the same button is suppressed —
    // except for the targets the dial declines (composer, editable fields),
    // and except when the global hook is not delivering at all (accessibility
    // permission missing): suppressing then would make right-click do
    // nothing anywhere, with no clue why. In that state the native menu is
    // left alone and the permission problem is surfaced once.
    const onContextMenu = (event: MouseEvent) => {
      if (isRadialGestureExempt(event.target)) return;
      if (hookLiveRef.current === false) {
        if (!permissionToastShownRef.current) {
          permissionToastShownRef.current = true;
          showToast({
            title: "The radial dial needs Accessibility permission",
            description:
              "Enable Stella under System Settings → Privacy & Security → Accessibility, then click back into the app.",
            duration: 8000,
          });
        }
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu, true);

    const cleanups: Array<() => void> = [];
    if (shellRadial) {
      cleanups.push(
        shellRadial.onQueryPress((_event, data) => {
          const target = document.elementFromPoint(data.x, data.y);
          shellRadial.respondPress(data.token, !isRadialGestureExempt(target));
        }),
        shellRadial.onCommit((_event, data) => {
          const action = WEDGE_ACTIONS[data.index];
          if (!action) return;
          if (action === "close") {
            displayTabs.setPanelOpen(false);
            return;
          }
          sidebarSections.selectSection(action);
        }),
      );
    }

    return () => {
      window.removeEventListener("focus", refreshHookLiveness);
      window.removeEventListener("contextmenu", onContextMenu, true);
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  return null;
}
