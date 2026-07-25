/**
 * The overlay window's radial dial — the system-wide one, raised by holding the
 * global trigger chord.
 *
 * This is only a driver. It owns no geometry and no motion: it subscribes to
 * the main process's `radial:*` IPC, keeps the highlighted wedge in sync with
 * the cursor, and renders `RadialDialSurface`. The gesture itself is captured
 * globally in the main process by `uiohook`, which is why nothing here binds a
 * pointer event — by the time a cursor position arrives it has already been
 * resolved against the dial's screen bounds.
 *
 * Selection is committed in the main process too (`radial-wedge.ts` recomputes
 * it from the release position), so the wedge this component highlights is
 * advisory. Both sides hit-test through the same shared geometry to keep the
 * highlight and the committed action from disagreeing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, MessageSquare, Mic, Plus, X } from "@/ui/icons";
import { getElectronApi } from "@/platform/electron/electron";
import { getWedgeIndexAt } from "@/shared/lib/radial-geometry";
import { useTheme } from "@/context/theme-context";
import type { RadialWedge } from "@/shared/types/electron";
import {
  RadialDialSurface,
  type RadialDialWedge,
} from "./RadialDialSurface";
import { useRadialDialAnimation } from "./use-radial-dial-animation";

const BASE_WEDGES: readonly RadialDialWedge[] = [
  { id: "capture", label: "Capture", icon: Camera },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "add", label: "Add", icon: Plus },
  { id: "voice", label: "Voice", icon: Mic },
];

export function RadialDial({
  closeChatWedge = false,
}: {
  closeChatWedge?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addIconDataUrl, setAddIconDataUrl] = useState<string | null>(null);
  const { colors } = useTheme();

  const wedges = useMemo<readonly RadialDialWedge[]>(
    () =>
      BASE_WEDGES.map((wedge) => {
        if (wedge.id === "chat" && closeChatWedge) {
          return { ...wedge, label: "Close", icon: X };
        }
        if (wedge.id === "add") {
          return { ...wedge, iconDataUrl: addIconDataUrl };
        }
        return wedge;
      }),
    [closeChatWedge, addIconDataUrl],
  );

  const selectedIndex = useMemo(
    () => (selectedId ? BASE_WEDGES.findIndex((w) => w.id === selectedId) : -1),
    [selectedId],
  );

  const animation = useRadialDialAnimation({
    colors,
    selectedIndex,
    onCloseComplete: () => {
      // Tells the main process the fade is done so it can drop the overlay
      // window; it also runs a fallback timer in case this never arrives.
      requestAnimationFrame(() => {
        window.electronAPI?.radial.animDone?.();
      });
    },
  });

  const { show, hide } = animation;
  const showRef = useRef(show);
  showRef.current = show;
  const hideRef = useRef(hide);
  hideRef.current = hide;

  useEffect(() => {
    if (!getElectronApi()) return;
    const electronAPI = window.electronAPI;
    if (!electronAPI?.radial.onShow) return;

    const resolveWedge = (
      x: number,
      y: number,
      centerX: number,
      centerY: number,
    ): string | null => {
      const index = getWedgeIndexAt(x, y, centerX, centerY);
      return index === null ? null : (BASE_WEDGES[index]?.id ?? null);
    };

    const cleanupShow = electronAPI.radial.onShow(
      (
        _event: unknown,
        data: { centerX: number; centerY: number; x?: number; y?: number },
      ) => {
        // Reset to the Plus glyph; the icon of the app under the dial arrives
        // asynchronously via radial:addIcon once the window lookup settles.
        setAddIconDataUrl(null);
        setSelectedId(
          typeof data.x === "number" && typeof data.y === "number"
            ? resolveWedge(data.x, data.y, data.centerX, data.centerY)
            : null,
        );
        showRef.current();
      },
    );

    const cleanupHide = electronAPI.radial.onHide(() => {
      setSelectedId(null);
      hideRef.current();
    });

    const cleanupCursor = electronAPI.radial.onCursor(
      (
        _event: unknown,
        data: { x: number; y: number; centerX: number; centerY: number },
      ) => {
        const wedge = resolveWedge(data.x, data.y, data.centerX, data.centerY);
        setSelectedId((prev) => (prev === wedge ? prev : wedge));
      },
    );

    const cleanupAddIcon = electronAPI.radial.onAddIcon(
      (_event: unknown, data: { iconDataUrl: string | null }) => {
        setAddIconDataUrl(data?.iconDataUrl ?? null);
      },
    );

    return () => {
      cleanupShow();
      cleanupHide();
      cleanupCursor();
      cleanupAddIcon();
    };
  }, []);

  return (
    <RadialDialSurface
      wedges={wedges}
      selectedId={selectedId}
      phase={animation.phase}
      contentVisible={animation.contentVisible}
      canvasRef={animation.canvasRef}
      reducedMotion={animation.reducedMotion}
    />
  );
}

/** Re-exported for the main process's wedge-id contract. */
export type { RadialWedge };
