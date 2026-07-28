/**
 * The shell's end of the right-button radial dial.
 *
 * The dial is painted by the always-on-top overlay window and the gesture is
 * owned by the main process (`shell-radial-gesture-service`), which accepts
 * two sources. This bridge is the permissionless one: a right-press that
 * lands on ordinary shell DOM is announced over `shell-radial:dom-begin` and
 * followed by throttled move ticks and the release, so a fresh install with
 * no accessibility permission still has a working dial everywhere the
 * renderer can see the press. Presses inside embedded content (artifact
 * iframes, viewers, webviews) never reach this document; those ride the
 * global input hook instead, and when that hook is not running the main
 * process reports them over `shell-radial:swallowed-press` so the missing
 * permission is surfaced exactly when it mattered.
 *
 * While a renderer-begun gesture is live a full-window shield keeps moves
 * and the release hit-testing to this document (embedded frames and window
 * drag regions would otherwise eat them — when the hook is running it
 * backstops those, but the shield is what keeps the no-permission path
 * whole). `shell-radial:ended` clears local state for gestures the main
 * process resolved through the hook, whose closing events the DOM never saw.
 *
 * Also here: answering `shell-radial:query-press` for hook presses (only the
 * DOM can see whether the target is exempt — composer and editable fields
 * keep their native context menu), applying `shell-radial:commit` (sections
 * route through `sidebarSections.selectSection`, the same verb the tab rail
 * uses; the Search wedge summons the centered workspace search), and
 * suppressing the OS
 * context menu for every press the dial claims.
 */

import { useEffect, useState } from "react";
import {
  sidebarSections,
  type SidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { showToast } from "@/ui/toast";
import { isRadialGestureExempt } from "./radial-gesture-target";
import { radialSearchStore } from "./radial-search-store";
import "./shell-radial-bridge.css";

/**
 * Wedge index → action, in the shared quadrant order (index 0 upper-right,
 * clockwise). Must match `SHELL_WEDGES` in the overlay's RadialDial — the
 * main process commits by index against that same order.
 */
const WEDGE_ACTIONS: readonly (SidebarSection | "search")[] = [
  "home",
  "files",
  "search",
  "apps",
];

const DOM_MOVE_THROTTLE_MS = 8;

export function ShellRadialBridge() {
  const [gestureLive, setGestureLive] = useState(false);

  useEffect(() => {
    const shellRadial = window.electronAPI?.shellRadial;

    // Local mirror of "a renderer-begun gesture is in flight". Drives the
    // shield and gates the move/up senders; cleared locally on release or
    // cancel and remotely by `shell-radial:ended`.
    let domGestureLive = false;
    let lastMoveSentAt = 0;
    let permissionToastShown = false;

    const setLive = (live: boolean) => {
      domGestureLive = live;
      setGestureLive(live);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2 || !shellRadial) return;
      if (domGestureLive) return;
      if (isRadialGestureExempt(event.target)) return;
      event.preventDefault();
      setLive(true);
      shellRadial.beginDomGesture();
    };

    const onPointerMove = () => {
      if (!domGestureLive || !shellRadial) return;
      const now = Date.now();
      if (now - lastMoveSentAt < DOM_MOVE_THROTTLE_MS) return;
      lastMoveSentAt = now;
      shellRadial.moveDomGesture();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!domGestureLive || event.button !== 2 || !shellRadial) return;
      event.preventDefault();
      setLive(false);
      shellRadial.endDomGesture();
    };

    const cancelDomGesture = () => {
      if (!domGestureLive || !shellRadial) return;
      setLive(false);
      shellRadial.cancelDomGesture();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelDomGesture();
    };

    const onRendererMouseLeave = () => {
      if (!domGestureLive || !shellRadial) return;
      // The overlay window itself can trigger this signal. Main owns the real
      // app bounds and only cancels when the physical cursor is outside them.
      shellRadial.leaveDomGesture();
    };

    // The dial claims the right button across the shell surface, so the
    // context menu the OS would raise on the same button is suppressed —
    // except for the targets the dial declines (composer, editable fields).
    const onContextMenu = (event: MouseEvent) => {
      if (isRadialGestureExempt(event.target)) return;
      event.preventDefault();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", cancelDomGesture, true);
    // Unlike a bubbling `pointerout`, the root's own `mouseleave` is not
    // emitted when the gesture shield mounts under the cursor. It only fires
    // when the pointer actually exits the renderer, which is the cancellation
    // boundary this gesture needs.
    document.documentElement.addEventListener(
      "mouseleave",
      onRendererMouseLeave,
    );
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancelDomGesture);
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
          if (action === "search") {
            radialSearchStore.open();
            return;
          }
          sidebarSections.selectSection(action);
        }),
        shellRadial.onEnded(() => {
          // The main process resolved the gesture (possibly via the global
          // hook, whose closing events this document never saw).
          setLive(false);
        }),
        shellRadial.onSwallowedPress(() => {
          if (permissionToastShown) return;
          permissionToastShown = true;
          showToast({
            title: "Grant Accessibility to use the dial over content",
            description:
              "Right-click works everywhere else, but presses on files and apps need Stella enabled under System Settings → Privacy & Security → Accessibility.",
            duration: 8000,
          });
        }),
      );
    }

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", cancelDomGesture, true);
      document.documentElement.removeEventListener(
        "mouseleave",
        onRendererMouseLeave,
      );
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancelDomGesture);
      window.removeEventListener("contextmenu", onContextMenu, true);
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  return gestureLive ? (
    <div className="shell-radial-gesture-shield" aria-hidden="true" />
  ) : null;
}
