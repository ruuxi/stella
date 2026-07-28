/**
 * The overlay window's radial dial, in two variants that share one surface:
 * the system-wide dial raised by holding the global trigger chord, and the
 * shell dial raised by holding the right mouse button over the full window.
 * `radial:show` carries which variant a session is; the wedge set and the
 * committed meaning differ, the gesture machinery does not.
 *
 * This is only a driver. It owns no geometry and no motion: it subscribes to
 * the main process's `radial:*` IPC, keeps the highlighted wedge in sync with
 * the cursor, and renders `RadialDialSurface`. The gesture itself is captured
 * globally in the main process by `uiohook`, which is why nothing here binds a
 * pointer event — by the time a cursor position arrives it has already been
 * resolved against the dial's screen bounds. Living in the always-on-top
 * overlay window is what makes it reliable over any content: it never fights
 * embedded frames or drag regions for events, because it receives none.
 *
 * Selection is committed in the main process too (`radial-wedge.ts` recomputes
 * it from the release position), so the wedge this component highlights is
 * advisory. Both sides hit-test through the same shared geometry to keep the
 * highlight and the committed action from disagreeing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindowMac,
  Camera,
  Folder,
  LayoutList,
  MessageSquare,
  Mic,
  Plus,
  Search,
  X,
} from "@/ui/icons";
import { getElectronApi } from "@/platform/electron/electron";
import { getWedgeIndexAt } from "@/shared/lib/radial-geometry";
import { SHELL_RADIAL_SCALE } from "@/shared/lib/layout";
import { useTheme } from "@/context/theme-context";
import type { RadialWedge } from "@/shared/types/electron";
import { RadialDialSurface, type RadialDialWedge } from "./RadialDialSurface";
import { useRadialDialAnimation } from "./use-radial-dial-animation";

const BASE_WEDGES: readonly RadialDialWedge[] = [
  { id: "capture", label: "Capture", icon: Camera },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "add", label: "Add", icon: Plus },
  { id: "voice", label: "Voice", icon: Mic },
];

/**
 * The shell variant's wedges, in the shared quadrant order (index 0 at the
 * upper-right, clockwise). Home/Files/Apps mirror the sidebar's tab rail;
 * Search is dial-only — it summons the centered workspace search overlay.
 * The main process commits by index; the shell maps indices through this same
 * order (see ShellRadialBridge), so the two must not drift.
 */
const SHELL_WEDGES: readonly RadialDialWedge[] = [
  { id: "home", label: "Home", icon: LayoutList },
  { id: "files", label: "Files", icon: Folder },
  { id: "search", label: "Search", icon: Search },
  { id: "apps", label: "Apps", icon: AppWindowMac },
];

export type RadialDialVariant = "system" | "shell";

export function RadialDial({
  closeChatWedge = false,
  variant = "system",
}: {
  closeChatWedge?: boolean;
  variant?: RadialDialVariant;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addIconDataUrl, setAddIconDataUrl] = useState<string | null>(null);
  const { colors } = useTheme();

  const wedges = useMemo<readonly RadialDialWedge[]>(() => {
    if (variant === "shell") return SHELL_WEDGES;
    return BASE_WEDGES.map((wedge) => {
      if (wedge.id === "chat" && closeChatWedge) {
        return { ...wedge, label: "Close", icon: X };
      }
      if (wedge.id === "add") {
        return { ...wedge, iconDataUrl: addIconDataUrl };
      }
      return wedge;
    });
  }, [variant, closeChatWedge, addIconDataUrl]);

  const selectedIndex = useMemo(
    () => (selectedId ? wedges.findIndex((w) => w.id === selectedId) : -1),
    [selectedId, wedges],
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
  // The IPC effect runs once; it reads the live variant through a ref.
  const variantRef = useRef<RadialDialVariant>("system");

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
      const scale =
        variantRef.current === "shell" ? SHELL_RADIAL_SCALE : 1;
      const index = getWedgeIndexAt(
        centerX + (x - centerX) / scale,
        centerY + (y - centerY) / scale,
        centerX,
        centerY,
      );
      if (index === null) return null;
      const set = variantRef.current === "shell" ? SHELL_WEDGES : BASE_WEDGES;
      return set[index]?.id ?? null;
    };

    const cleanupShow = electronAPI.radial.onShow(
      (
        _event: unknown,
        data: {
          centerX: number;
          centerY: number;
          x?: number;
          y?: number;
          variant?: RadialDialVariant;
        },
      ) => {
        const nextVariant: RadialDialVariant =
          data.variant === "shell" ? "shell" : "system";
        variantRef.current = nextVariant;
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
      scale={variant === "shell" ? SHELL_RADIAL_SCALE : 1}
    />
  );
}

/** Re-exported for the main process's wedge-id contract. */
export type { RadialWedge };
