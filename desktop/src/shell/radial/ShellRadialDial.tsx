/**
 * The shell's radial dial — raised by holding the right mouse button, and used
 * to pick which of the sidebar's four sections to show.
 *
 * Press-drag-release, matching the system dial's gesture: the dial appears
 * centered on the press, the wedge under the cursor highlights as you drag, and
 * releasing over one selects it. Releasing in the dead zone dismisses without
 * acting.
 *
 * It shares the system dial's geometry, motion and appearance
 * (`RadialDialSurface`, `useRadialDialAnimation`) and differs only in what
 * raises it and what a selection does. The two never coexist — the system one
 * lives in a separate always-on-top overlay window — so the WebGL blob's
 * module-level singleton is not contended.
 *
 * Selection routes through `sidebarSections.selectSection`, the same verb the
 * tab rail uses, so the dial inherits open/switch/close and per-section memory
 * rather than restating them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SIDEBAR_SECTIONS,
  sidebarSections,
  type SidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import {
  RADIAL_CENTER,
  RADIAL_DIAL_SIZE,
  getWedgeIndexAt,
} from "@/shared/lib/radial-geometry";
import { useTheme } from "@/context/theme-context";
import { SIDEBAR_SECTION_META } from "@/shell/sidebar-sections/SidebarTabRail";
import {
  RadialDialSurface,
  type RadialDialWedge,
} from "@/shell/overlay/RadialDialSurface";
import { useRadialDialAnimation } from "@/shell/overlay/use-radial-dial-animation";
import { isRadialGestureExempt } from "./radial-gesture-target";
import "./shell-radial-dial.css";

type SectionWedge = RadialDialWedge & { id: SidebarSection };

/**
 * Wedge order follows `SIDEBAR_SECTIONS`, which is also the tab rail's order,
 * so a section sits in the same relative position in both. Wedge 0 starts at 12
 * o'clock and they advance clockwise, occupying quadrants: Tasks upper-right,
 * Files lower-right, Search lower-left, Apps upper-left.
 */
const WEDGES: readonly SectionWedge[] = SIDEBAR_SECTIONS.map((section) => ({
  id: section,
  label: SIDEBAR_SECTION_META[section].label,
  icon: SIDEBAR_SECTION_META[section].Icon,
}));

type Origin = { x: number; y: number };

export function ShellRadialDial() {
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [selectedId, setSelectedId] = useState<SidebarSection | null>(null);
  const { colors } = useTheme();

  const selectedIndex = useMemo(
    () => (selectedId ? WEDGES.findIndex((w) => w.id === selectedId) : -1),
    [selectedId],
  );

  const animation = useRadialDialAnimation({ colors, selectedIndex });
  const { show, hide } = animation;

  // The gesture runs on window-level listeners, so its handlers are installed
  // once and read live state through refs rather than re-subscribing per frame.
  const originRef = useRef<Origin | null>(null);
  const selectedRef = useRef<SidebarSection | null>(null);
  selectedRef.current = selectedId;
  const showRef = useRef(show);
  showRef.current = show;
  const hideRef = useRef(hide);
  hideRef.current = hide;

  const endGesture = useCallback((commit: boolean) => {
    const wasActive = originRef.current !== null;
    originRef.current = null;
    if (!wasActive) return;

    const selected = selectedRef.current;
    setOrigin(null);
    setSelectedId(null);
    hideRef.current();

    if (commit && selected) {
      sidebarSections.selectSection(selected);
    }
  }, []);

  useEffect(() => {
    const wedgeAt = (
      clientX: number,
      clientY: number,
    ): SidebarSection | null => {
      const current = originRef.current;
      if (!current) return null;
      const index = getWedgeIndexAt(clientX, clientY, current.x, current.y);
      return index === null ? null : (WEDGES[index]?.id ?? null);
    };

    // One begin/move/finish set shared by both drivers: the window's own
    // pointer listeners, and the main process's IPC stream for presses that
    // land inside embedded frames (artifact iframes, webviews) which this
    // document never sees.
    const beginGesture = (x: number, y: number) => {
      // A press inside an embedded frame moves keyboard focus into it, and a
      // focused frame swallows the Escape that is supposed to cancel the
      // gesture. Pull focus back to this document before the dial opens.
      const active = document.activeElement;
      if (
        active instanceof HTMLIFrameElement ||
        active instanceof HTMLObjectElement ||
        active instanceof HTMLEmbedElement ||
        active?.tagName === "WEBVIEW"
      ) {
        (active as HTMLElement).blur();
      }

      const next = { x, y };
      originRef.current = next;
      setOrigin(next);
      // A press that has not moved yet sits at the exact center, which is
      // inside the dead zone — so the dial opens with nothing selected.
      setSelectedId(null);
      showRef.current();
    };

    const moveGesture = (x: number, y: number) => {
      if (!originRef.current) return;
      const wedge = wedgeAt(x, y);
      setSelectedId((prev) => (prev === wedge ? prev : wedge));
    };

    const finishGesture = (x: number, y: number) => {
      if (!originRef.current) return;
      // Resolve from the release position rather than trusting the last move,
      // so a release that outruns the final pointermove still commits the wedge
      // the cursor actually ended on.
      selectedRef.current = wedgeAt(x, y);
      endGesture(true);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2) return;
      if (originRef.current) return;
      if (isRadialGestureExempt(event.target)) return;

      event.preventDefault();
      beginGesture(event.clientX, event.clientY);
    };

    const onPointerMove = (event: PointerEvent) => {
      moveGesture(event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!originRef.current || event.button !== 2) return;
      event.preventDefault();
      finishGesture(event.clientX, event.clientY);
    };

    const onPointerCancel = () => endGesture(false);

    // The press already opened the dial, so the context menu the OS would
    // raise on the same button is suppressed for the duration of the gesture.
    const onContextMenu = (event: MouseEvent) => {
      if (isRadialGestureExempt(event.target)) return;
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") endGesture(false);
    };

    const onBlur = () => endGesture(false);

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);

    // The IPC driver: right-presses inside embedded frames arrive from the
    // main process (via the webContents context-menu event), along with the
    // global move/up stream for that gesture — the frame that owns the press
    // keeps routing the drag to itself, so the DOM listeners above may never
    // hear from it again.
    const shellRadial = window.electronAPI?.shellRadial;
    const cleanups: Array<() => void> = [];
    if (shellRadial) {
      cleanups.push(
        shellRadial.onPress((_event, data) => {
          if (originRef.current) return;
          beginGesture(data.x, data.y);
        }),
        shellRadial.onMove((_event, data) => moveGesture(data.x, data.y)),
        shellRadial.onUp((_event, data) => finishGesture(data.x, data.y)),
        shellRadial.onCancel(() => endGesture(false)),
      );
    }

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      for (const cleanup of cleanups) cleanup();
    };
  }, [endGesture]);

  return (
    <>
      {/* While a gesture is live, this shield owns hit-testing for the whole
          window. Without it, dragging over an embedded frame (an artifact
          iframe, a webview) routes the move — and worse, the release — into
          that frame's document instead of this one, and the dial never hears
          the pointerup that should resolve it. Pointer capture does not help
          here: Chromium still routes per-event by hit-test across frame
          boundaries, so the fix is to win the hit-test. */}
      {origin !== null ? (
        <div className="shell-radial-gesture-shield" aria-hidden="true" />
      ) : null}
      <div
        className="shell-radial-dial"
        data-visible={origin !== null ? "true" : undefined}
        style={
          origin
            ? {
                left: origin.x - RADIAL_CENTER,
                top: origin.y - RADIAL_CENTER,
                width: RADIAL_DIAL_SIZE,
                height: RADIAL_DIAL_SIZE,
              }
            : undefined
        }
        aria-hidden="true"
      >
        {/* Always mounted, even while hidden. The blob's WebGL context binds to
          this canvas once on mount and warms a frame there; rendering the
          surface only while visible would leave the canvas absent at that
          moment, so the blob would never initialize and every open would fall
          back to the un-animated path. */}
        <RadialDialSurface
          wedges={WEDGES}
          selectedId={selectedId}
          phase={animation.phase}
          contentVisible={animation.contentVisible}
          canvasRef={animation.canvasRef}
          reducedMotion={animation.reducedMotion}
        />
      </div>
    </>
  );
}
