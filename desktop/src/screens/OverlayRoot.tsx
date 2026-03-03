import { useCallback, useEffect, useRef, useState } from "react";
import { RadialDial } from "./RadialDial";
import { RegionCapture } from "./RegionCapture";
import { MiniShell } from "./mini-shell/MiniShell";
import { VoiceOverlay } from "../components/VoiceOverlay";

/**
 * OverlayRoot manages the unified transparent overlay window.
 *
 * All overlay components (Radial Dial, Region Capture, Mini Shell, and
 * modifier-block behavior) live as absolutely-positioned children.
 * The overlay window is hidden when idle and only shown when a component
 * activates, preventing it from blocking interaction with windows below.
 *
 * Hit-testing: the renderer tracks visible component bounding rects and
 * notifies the main process to toggle `setIgnoreMouseEvents` accordingly.
 */

type OverlayState = {
  /** Whether context-menu blocking is active (replaces modifier overlay) */
  modifierBlock: boolean;
  /** Whether the radial dial is visible (driven by radial:show/hide IPC) */
  radialVisible: boolean;
  /** Screen position for the radial container (DIP coords) */
  radialPosition: { x: number; y: number } | null;
  /** Whether region capture mode is active */
  regionCaptureActive: boolean;
  /** Whether the mini shell is visible */
  miniVisible: boolean;
  /** Whether screenshot preview modal is open inside mini shell */
  miniPreviewVisible: boolean;
  /** Position for the mini shell (screen coords relative to overlay origin) */
  miniPosition: { x: number; y: number } | null;
  /** Whether standalone voice overlay is visible */
  voiceVisible: boolean;
  /** Position for standalone voice overlay */
  voicePosition: { x: number; y: number } | null;
};

const initialState: OverlayState = {
  modifierBlock: false,
  radialVisible: false,
  radialPosition: null,
  regionCaptureActive: false,
  miniVisible: false,
  miniPreviewVisible: false,
  miniPosition: null,
  voiceVisible: false,
  voicePosition: null,
};

const MINI_SHELL_SIZE = {
  width: 480,
  height: 700,
} as const;

const VOICE_PILL_SIZE = {
  width: 148,
  height: 36,
} as const;

export function OverlayRoot() {
  const [state, setState] = useState<OverlayState>(initialState);
  const interactiveRef = useRef(false);
  const miniRef = useRef<HTMLDivElement>(null);
  const radialRef = useRef<HTMLDivElement>(null);
  const miniDisplayed = state.miniVisible && !state.regionCaptureActive;

  // Mini shell drag (custom, replaces -webkit-app-region: drag)
  // The mini shell is inside the overlay, so -webkit-app-region: drag would
  // move the entire fullscreen overlay. Instead, we mutate the DOM directly
  // during drag (to avoid re-rendering the entire tree on every mousemove)
  // and commit the final position to React state on mouseup.
  const miniDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleMiniTitlebarMouseDown = useCallback((e: React.MouseEvent) => {
    // Only left button, only on the titlebar drag area (not buttons/inputs)
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Must be inside .mini-titlebar but not inside interactive child areas
    if (!target.closest(".mini-titlebar")) return;
    if (target.closest(".mini-titlebar-left, .mini-titlebar-right, button, input, textarea")) return;
    e.preventDefault();
    const el = miniRef.current;
    if (!el) return;
    miniDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: parseInt(el.style.left, 10) || 0,
      origY: parseInt(el.style.top, 10) || 0,
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!miniDragRef.current || !miniRef.current) return;
      const dx = e.clientX - miniDragRef.current.startX;
      const dy = e.clientY - miniDragRef.current.startY;
      // Direct DOM mutation with no React re-render.
      miniRef.current.style.left = `${miniDragRef.current.origX + dx}px`;
      miniRef.current.style.top = `${miniDragRef.current.origY + dy}px`;
    };
    const handleMouseUp = () => {
      if (miniDragRef.current && miniRef.current) {
        // Commit final position to React state
        const x = parseInt(miniRef.current.style.left, 10) || 0;
        const y = parseInt(miniRef.current.style.top, 10) || 0;
        setState((prev) => ({ ...prev, miniPosition: { x, y } }));
      }
      miniDragRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Radial dial positioning (driven by radial:show/hide IPC).
  // The RadialDial component handles its own animation state via these same
  // IPC channels. OverlayRoot additionally tracks visibility and position
  // to control the container element's CSS and hit-testing.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // radial:show includes extra screenX/screenY for container positioning
    const cleanupShow = api.onRadialShow(
      (_event: unknown, data: { centerX: number; centerY: number; x?: number; y?: number; screenX?: number; screenY?: number }) => {
        if (typeof data.screenX === "number" && typeof data.screenY === "number") {
          setState((prev) => ({
            ...prev,
            radialVisible: true,
            radialPosition: { x: data.screenX!, y: data.screenY! },
          }));
        } else {
          setState((prev) => ({ ...prev, radialVisible: true }));
        }
      },
    );
    const cleanupHide = api.onRadialHide(() => {
      // Do not immediately set radialVisible=false. The RadialDial plays a
      // close animation and calls radialAnimDone. We hide after a short delay
      // to let the animation complete.
      setTimeout(() => {
        setState((prev) => ({ ...prev, radialVisible: false }));
      }, 300);
    });

    return () => {
      cleanupShow();
      cleanupHide();
    };
  }, []);

  // Modifier block (context-menu suppression).
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanup = api.onOverlayModifierBlock?.((active: boolean) => {
      setState((prev) => ({ ...prev, modifierBlock: active }));
    });
    return () => cleanup?.();
  }, []);

  // Block native context menu when modifier block is active
  useEffect(() => {
    if (!state.modifierBlock) return;
    const handler = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", handler, true);
    return () => document.removeEventListener("contextmenu", handler, true);
  }, [state.modifierBlock]);

  // Region capture.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupStart = api.onOverlayStartRegionCapture?.(() => {
      setState((prev) => ({ ...prev, regionCaptureActive: true }));
    });
    const cleanupEnd = api.onOverlayEndRegionCapture?.(() => {
      setState((prev) => ({ ...prev, regionCaptureActive: false }));
    });
    return () => {
      cleanupStart?.();
      cleanupEnd?.();
    };
  }, []);

  // Mini shell visibility.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanup = api.onOverlayShowMini?.((data: { x: number; y: number }) => {
      setState((prev) => ({
        ...prev,
        miniVisible: true,
        miniPosition: { x: data.x, y: data.y },
      }));
    });
    const cleanupHide = api.onOverlayHideMini?.(() => {
      setState((prev) => ({ ...prev, miniVisible: false }));
    });
    const cleanupRestore = api.onOverlayRestoreMini?.(() => {
      setState((prev) => ({ ...prev, miniVisible: true }));
    });
    return () => {
      cleanup?.();
      cleanupHide?.();
      cleanupRestore?.();
    };
  }, []);

  const handleMiniPreviewVisibilityChange = useCallback((visible: boolean) => {
    setState((prev) =>
      prev.miniPreviewVisible === visible ? prev : { ...prev, miniPreviewVisible: visible },
    );
  }, []);

  const handleVoiceTranscript = useCallback((transcript: string) => {
    window.electronAPI?.submitVoiceTranscript?.(transcript);
  }, []);

  // Standalone voice overlay visibility/position.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupShow = api.onOverlayShowVoice?.((data: { x: number; y: number; mode: "stt" | "realtime" }) => {
      setState((prev) => ({
        ...prev,
        voiceVisible: true,
        voicePosition: { x: data.x, y: data.y },
      }));
    });
    const cleanupHide = api.onOverlayHideVoice?.(() => {
      setState((prev) => ({ ...prev, voiceVisible: false }));
    });

    return () => {
      cleanupShow?.();
      cleanupHide?.();
    };
  }, []);

  // Hit-testing: toggle setIgnoreMouseEvents.
  const updateInteractive = useCallback((shouldBeInteractive: boolean) => {
    if (interactiveRef.current === shouldBeInteractive) return;
    interactiveRef.current = shouldBeInteractive;
    window.electronAPI?.overlaySetInteractive?.(shouldBeInteractive);
  }, []);

  useEffect(() => {
    // When region capture is active, the entire overlay must be interactive
    if (state.regionCaptureActive) {
      updateInteractive(true);
      return;
    }

    // Screenshot preview behaves like a modal over the overlay; keep full hit-test enabled.
    if (state.miniPreviewVisible) {
      updateInteractive(true);
      return;
    }

    // When modifier block is active, the overlay must capture right-clicks
    if (state.modifierBlock) {
      updateInteractive(true);
      return;
    }

    // When radial is visible, main process handles interactivity directly
    if (state.radialVisible) {
      return;
    }

    // For mini shell and standalone voice: only interactive when cursor is
    // over an active interactive region.
    if (!state.miniVisible && !state.voiceVisible) {
      updateInteractive(false);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      let isOverMini = false;
      if (state.miniVisible) {
        const miniEl = miniRef.current;
        if (miniEl) {
          const rect = miniEl.getBoundingClientRect();
          isOverMini =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
        }
      }

      let isOverVoice = false;
      if (state.voiceVisible && state.voicePosition) {
        const left = state.voicePosition.x - VOICE_PILL_SIZE.width / 2;
        const top = state.voicePosition.y - VOICE_PILL_SIZE.height / 2;
        isOverVoice =
          e.clientX >= left &&
          e.clientX <= left + VOICE_PILL_SIZE.width &&
          e.clientY >= top &&
          e.clientY <= top + VOICE_PILL_SIZE.height;
      }

      updateInteractive(isOverMini || isOverVoice);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [
    state.regionCaptureActive,
    state.miniPreviewVisible,
    state.modifierBlock,
    state.radialVisible,
    state.miniVisible,
    state.voiceVisible,
    state.voicePosition,
    updateInteractive,
  ]);

  // When nothing is active, ensure we're click-through
  useEffect(() => {
    const anythingActive =
      state.modifierBlock ||
      state.radialVisible ||
      state.regionCaptureActive ||
      state.miniPreviewVisible ||
      state.miniVisible ||
      state.voiceVisible;

    if (!anythingActive) {
      updateInteractive(false);
    }
  }, [state, updateInteractive]);

  return (
    <div
      className="overlay-root"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {/* Radial Dial: always mounted; visibility is managed via IPC.
          When not visible, position off-screen so the compositor's stale
          backing-store frame doesn't flash at the old position when the
          overlay window transitions from hidden → visible. */}
      <div
        ref={radialRef}
        className="radial-shell"
        style={{
          position: "absolute",
          left: state.radialVisible ? (state.radialPosition?.x ?? 0) : -9999,
          top: state.radialVisible ? (state.radialPosition?.y ?? 0) : -9999,
          width: 280,
          height: 280,
          pointerEvents: state.radialVisible ? "auto" : "none",
        }}
      >
        <RadialDial />
      </div>

      {/* Region capture: mounted only when active. */}
      {state.regionCaptureActive && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}>
          <RegionCapture />
        </div>
      )}

      {/* Mini shell: always mounted for context sync, visibility via CSS. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={miniRef}
        onMouseDown={handleMiniTitlebarMouseDown}
        style={{
          position: "absolute",
          left: state.miniPosition?.x ?? 0,
          top: state.miniPosition?.y ?? 0,
          width: MINI_SHELL_SIZE.width,
          height: MINI_SHELL_SIZE.height,
          pointerEvents: miniDisplayed ? "auto" : "none",
          opacity: miniDisplayed ? 1 : 0,
          visibility: miniDisplayed ? "visible" : "hidden",
        }}
      >
        <MiniShell onPreviewVisibilityChange={handleMiniPreviewVisibilityChange} />
      </div>

      {state.voiceVisible && state.voicePosition && (
        <VoiceOverlay
          onTranscript={handleVoiceTranscript}
          style={{
            position: "absolute",
            left: state.voicePosition.x,
            top: state.voicePosition.y,
            bottom: "auto",
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
    </div>
  );
}
