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

/**
 * Wedge order follows `SIDEBAR_SECTIONS`, which is also the tab rail's order,
 * so a section sits in the same relative position in both. Index 0 is at 12
 * o'clock and they advance clockwise: Tasks, Files, Search, Apps.
 */
const WEDGES: readonly RadialDialWedge[] = SIDEBAR_SECTIONS.map((section) => ({
  id: section,
  label: SIDEBAR_SECTION_META[section].label,
  icon: SIDEBAR_SECTION_META[section].Icon,
}));

type Origin = { x: number; y: number };

export function ShellRadialDial() {
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const selectedRef = useRef<string | null>(null);
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
      sidebarSections.selectSection(selected as SidebarSection);
    }
  }, []);

  useEffect(() => {
    const wedgeAt = (clientX: number, clientY: number): string | null => {
      const current = originRef.current;
      if (!current) return null;
      const index = getWedgeIndexAt(clientX, clientY, current.x, current.y);
      return index === null ? null : (WEDGES[index]?.id ?? null);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2) return;
      if (isRadialGestureExempt(event.target)) return;

      event.preventDefault();
      const next = { x: event.clientX, y: event.clientY };
      originRef.current = next;
      setOrigin(next);
      // A press that has not moved yet sits at the exact center, which is
      // inside the dead zone — so the dial opens with nothing selected.
      setSelectedId(null);
      showRef.current();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!originRef.current) return;
      const wedge = wedgeAt(event.clientX, event.clientY);
      setSelectedId((prev) => (prev === wedge ? prev : wedge));
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!originRef.current || event.button !== 2) return;
      event.preventDefault();
      // Resolve from the release position rather than trusting the last move,
      // so a release that outruns the final pointermove still commits the wedge
      // the cursor actually ended on.
      selectedRef.current = wedgeAt(event.clientX, event.clientY);
      endGesture(true);
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

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [endGesture]);

  const wedges = useMemo(() => WEDGES, []);

  return (
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
        wedges={wedges}
        selectedId={selectedId}
        phase={animation.phase}
        contentVisible={animation.contentVisible}
        canvasRef={animation.canvasRef}
        reducedMotion={animation.reducedMotion}
      />
    </div>
  );
}
