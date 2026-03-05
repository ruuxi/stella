import { useCallback, useEffect, useReducer, useRef, lazy, Suspense, type Dispatch } from "react";
import { MINI_SHELL_SIZE } from "@/lib/layout";
import { RadialDial } from "./RadialDial";
import { RegionCapture } from "./RegionCapture";
import { MiniShell } from "../shell/mini/MiniShell";
import { VoiceOverlay } from "@/app/overlay/VoiceOverlay";
import { MorphTransition } from "@/app/overlay/MorphTransition";

import { getNeriStore, getNeriWindowSummary } from "@/app/neri/neri-store";
import type { NeriWindowType } from "@/app/neri/neri-types";

const NeriDashboard = lazy(() => import("@/app/neri/NeriDashboard"));

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
  modifierBlock: boolean;
  radialVisible: boolean;
  radialPosition: { x: number; y: number } | null;
  regionCaptureActive: boolean;
  miniVisible: boolean;
  miniPreviewVisible: boolean;
  miniPosition: { x: number; y: number } | null;
  voiceVisible: boolean;
  voicePosition: { x: number; y: number } | null;
  neriVisible: boolean;
  neriCursor: { x: number; y: number } | null;
};

type OverlayAction =
  | { type: "radial:show"; position?: { x: number; y: number } }
  | { type: "radial:hide" }
  | { type: "modifier"; active: boolean }
  | { type: "region"; active: boolean }
  | { type: "mini:show"; position: { x: number; y: number } }
  | { type: "mini:hide" }
  | { type: "mini:restore" }
  | { type: "mini:position"; position: { x: number; y: number } }
  | { type: "mini:preview"; visible: boolean }
  | { type: "voice:show"; position: { x: number; y: number } }
  | { type: "voice:hide" }
  | { type: "neri:show"; cursor: { x: number; y: number } }
  | { type: "neri:hide" };

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
  neriVisible: false,
  neriCursor: null,
};

function overlayReducer(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case "radial:show":
      return { ...state, radialVisible: true, ...(action.position ? { radialPosition: action.position } : {}) };
    case "radial:hide":
      return { ...state, radialVisible: false };
    case "modifier":
      return { ...state, modifierBlock: action.active };
    case "region":
      return { ...state, regionCaptureActive: action.active };
    case "mini:show":
      return { ...state, miniVisible: true, miniPosition: action.position };
    case "mini:hide":
      return { ...state, miniVisible: false };
    case "mini:restore":
      return { ...state, miniVisible: true };
    case "mini:position":
      return { ...state, miniPosition: action.position };
    case "mini:preview":
      return state.miniPreviewVisible === action.visible ? state : { ...state, miniPreviewVisible: action.visible };
    case "voice:show":
      return { ...state, voiceVisible: true, voicePosition: action.position };
    case "voice:hide":
      return { ...state, voiceVisible: false };
    case "neri:show":
      return { ...state, neriVisible: true, neriCursor: action.cursor };
    case "neri:hide":
      return { ...state, neriVisible: false };
    default:
      return state;
  }
}

const VOICE_CREATURE_SIZE = {
  width: 168,
  height: 168,
} as const;

// ---------------------------------------------------------------------------
// Hook: useOverlayIPC
// Consolidates ALL IPC subscription effects (radial show/hide, modifier block,
// region capture, mini show/hide/restore, voice show/hide) into a single hook.
// Also handles context-menu suppression when modifier block is active.
// ---------------------------------------------------------------------------
function useOverlayIPC(dispatch: Dispatch<OverlayAction>, modifierBlock: boolean) {
  // Radial dial positioning (driven by radial:show/hide IPC).
  // The RadialDial component handles its own animation state via these same
  // IPC channels. OverlayRoot additionally tracks visibility and position
  // to control the container element's CSS and hit-testing.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // radial:show includes extra screenX/screenY for container positioning
    const cleanupShow = api.radial.onShow(
      (_event: unknown, data: { centerX: number; centerY: number; x?: number; y?: number; screenX?: number; screenY?: number }) => {
        if (typeof data.screenX === "number" && typeof data.screenY === "number") {
          dispatch({ type: "radial:show", position: { x: data.screenX!, y: data.screenY! } });
        } else {
          dispatch({ type: "radial:show" });
        }
      },
    );
    const cleanupHide = api.radial.onHide(() => {
      // Do not immediately set radialVisible=false. The RadialDial plays a
      // close animation and calls radialAnimDone. We hide after a short delay
      // to let the animation complete.
      setTimeout(() => {
        dispatch({ type: "radial:hide" });
      }, 300);
    });

    return () => {
      cleanupShow();
      cleanupHide();
    };
  }, [dispatch]);

  // Modifier block (context-menu suppression).
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanup = api.overlay.onModifierBlock?.((active: boolean) => {
      dispatch({ type: "modifier", active });
    });
    return () => cleanup?.();
  }, [dispatch]);

  // Block native context menu when modifier block is active
  useEffect(() => {
    if (!modifierBlock) return;
    const handler = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", handler, true);
    return () => document.removeEventListener("contextmenu", handler, true);
  }, [modifierBlock]);

  // Region capture.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupStart = api.overlay.onStartRegionCapture?.(() => {
      dispatch({ type: "region", active: true });
    });
    const cleanupEnd = api.overlay.onEndRegionCapture?.(() => {
      dispatch({ type: "region", active: false });
    });
    return () => {
      cleanupStart?.();
      cleanupEnd?.();
    };
  }, [dispatch]);

  // Mini shell visibility.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanup = api.overlay.onShowMini?.((data: { x: number; y: number }) => {
      dispatch({ type: "mini:show", position: { x: data.x, y: data.y } });
    });
    const cleanupHide = api.overlay.onHideMini?.(() => {
      dispatch({ type: "mini:hide" });
    });
    const cleanupRestore = api.overlay.onRestoreMini?.(() => {
      dispatch({ type: "mini:restore" });
    });
    return () => {
      cleanup?.();
      cleanupHide?.();
      cleanupRestore?.();
    };
  }, [dispatch]);

  // Standalone voice overlay visibility/position.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupShow = api.overlay.onShowVoice?.((data: { x: number; y: number; mode: "stt" | "realtime" }) => {
      dispatch({ type: "voice:show", position: { x: data.x, y: data.y } });
    });
    const cleanupHide = api.overlay.onHideVoice?.(() => {
      dispatch({ type: "voice:hide" });
    });

    return () => {
      cleanupShow?.();
      cleanupHide?.();
    };
  }, [dispatch]);

  // Neri dashboard visibility.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupShow = api.overlay.onShowNeri?.((data: { cursorX: number; cursorY: number }) => {
      dispatch({ type: "neri:show", cursor: { x: data.cursorX, y: data.cursorY } });
    });
    const cleanupHide = api.overlay.onHideNeri?.(() => {
      dispatch({ type: "neri:hide" });
    });
    return () => {
      cleanupShow?.();
      cleanupHide?.();
    };
  }, [dispatch]);

  // Neri Mercury command routing — IPC listeners from main process.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanups: (() => void)[] = [];

    const onSearch = api.overlay.onNeriOpenSearch?.((data: { query: string; results: Array<{ title: string; url: string; snippet: string }> }) => {
      getNeriStore().dispatch({ type: "open-search-window", query: data.query, results: data.results });
    });
    if (onSearch) cleanups.push(onSearch);

    const onCanvas = api.overlay.onNeriOpenCanvas?.((data: { title: string; html: string }) => {
      getNeriStore().dispatch({ type: "open-canvas-window", title: data.title, html: data.html });
    });
    if (onCanvas) cleanups.push(onCanvas);

    const onManage = api.overlay.onNeriManageWindow?.((data: { operation: string; window_type?: string }) => {
      if (data.operation === "close" && data.window_type) {
        getNeriStore().dispatch({ type: "close-window-by-type", windowType: data.window_type as NeriWindowType });
      }
    });
    if (onManage) cleanups.push(onManage);

    return () => { cleanups.forEach((c) => c()); };
  }, []);

  // Report Neri window state to main process for Mercury context.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.overlay.reportNeriWindowState) return;

    const store = getNeriStore();

    // Only report when the window list actually changes (not on scroll/focus)
    let lastJson = "";
    const report = () => {
      const summary = getNeriWindowSummary();
      const json = JSON.stringify(summary);
      if (json === lastJson) return;
      lastJson = json;
      api.overlay.reportNeriWindowState(summary);
    };

    const unsubscribe = store.subscribe(report);
    report(); // initial state

    return unsubscribe;
  }, []);
}

// ---------------------------------------------------------------------------
// Hook: useMiniDrag
// Extracts mini shell drag mechanics (mousedown handler + mousemove/mouseup
// effect). The mini shell lives inside a fullscreen overlay, so
// -webkit-app-region: drag would move the entire window. Instead we mutate
// the DOM directly during drag and commit the final position on mouseup.
// ---------------------------------------------------------------------------
function useMiniDrag(
  miniRef: React.RefObject<HTMLDivElement | null>,
  dispatch: Dispatch<OverlayAction>,
) {
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
  }, [miniRef]);

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
        dispatch({ type: "mini:position", position: { x, y } });
      }
      miniDragRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [miniRef, dispatch]);

  return { handleMiniTitlebarMouseDown };
}

// ---------------------------------------------------------------------------
// Hook: useOverlayHitTesting
// Manages the overlay's setIgnoreMouseEvents toggle based on which overlay
// subsystems are currently active and whether the cursor is over an
// interactive region.
// ---------------------------------------------------------------------------
function useOverlayHitTesting(
  state: OverlayState,
  miniRef: React.RefObject<HTMLDivElement | null>,
  neriRef: React.RefObject<HTMLDivElement | null>,
  updateInteractive: (shouldBeInteractive: boolean) => void,
) {
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

    // For mini shell, standalone voice, and neri: only interactive when cursor
    // is over an active interactive region.
    if (!state.miniVisible && !state.voiceVisible && !state.neriVisible) {
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
        const left = state.voicePosition.x - VOICE_CREATURE_SIZE.width / 2;
        const top = state.voicePosition.y - VOICE_CREATURE_SIZE.height / 2;
        isOverVoice =
          e.clientX >= left &&
          e.clientX <= left + VOICE_CREATURE_SIZE.width &&
          e.clientY >= top &&
          e.clientY <= top + VOICE_CREATURE_SIZE.height;
      }

      let isOverNeri = false;
      if (state.neriVisible) {
        const neriEl = neriRef.current;
        if (neriEl) {
          const rect = neriEl.getBoundingClientRect();
          isOverNeri =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
        }
      }

      updateInteractive(isOverMini || isOverVoice || isOverNeri);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [
    state.neriVisible,
    state.regionCaptureActive,
    state.miniPreviewVisible,
    state.modifierBlock,
    state.radialVisible,
    state.miniVisible,
    state.voiceVisible,
    state.voicePosition,
    miniRef,
    neriRef,
    updateInteractive,
  ]);

  useEffect(() => {
    const anythingActive =
      state.modifierBlock ||
      state.radialVisible ||
      state.regionCaptureActive ||
      state.miniPreviewVisible ||
      state.miniVisible ||
      state.voiceVisible ||
      state.neriVisible;

    if (!anythingActive) {
      updateInteractive(false);
    }
  }, [state, updateInteractive]);
}

// ---------------------------------------------------------------------------
// Component: OverlayRoot
// Composes the hooks above and renders the overlay subsystem JSX.
// ---------------------------------------------------------------------------
export function OverlayRoot() {
  const [state, dispatch] = useReducer(overlayReducer, initialState);
  const interactiveRef = useRef(false);
  const miniRef = useRef<HTMLDivElement>(null);
  const radialRef = useRef<HTMLDivElement>(null);
  const neriRef = useRef<HTMLDivElement>(null);
  const miniDisplayed = state.miniVisible && !state.regionCaptureActive;

  // Wire up all IPC subscriptions (radial, modifier, region, mini, voice)
  useOverlayIPC(dispatch, state.modifierBlock);

  // Mini shell drag mechanics
  const { handleMiniTitlebarMouseDown } = useMiniDrag(miniRef, dispatch);

  // Interactivity / hit-testing management
  const updateInteractive = useCallback((shouldBeInteractive: boolean) => {
    if (interactiveRef.current === shouldBeInteractive) return;
    interactiveRef.current = shouldBeInteractive;
    window.electronAPI?.overlay.setInteractive?.(shouldBeInteractive);
  }, []);

  useOverlayHitTesting(state, miniRef, neriRef, updateInteractive);

  const handleMiniPreviewVisibilityChange = useCallback((visible: boolean) => {
    dispatch({ type: "mini:preview", visible });
  }, []);

  const handleVoiceTranscript = useCallback((transcript: string) => {
    window.electronAPI?.voice.submitTranscript?.(transcript);
  }, []);

  const handleNeriClose = useCallback(() => {
    window.electronAPI?.overlay.hideNeri?.();
  }, []);

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

      <VoiceOverlay
        onTranscript={handleVoiceTranscript}
        style={
          state.voiceVisible && state.voicePosition
            ? {
                position: "absolute",
                left: state.voicePosition.x,
                top: state.voicePosition.y,
                bottom: "auto",
                transform: "translate(-50%, -50%)",
              }
            : undefined
        }
      />

      <MorphTransition />

      {/* Neri dashboard: mounted only when active */}
      {state.neriVisible && (
        <Suspense fallback={null}>
          <NeriDashboard onClose={handleNeriClose} panelRef={neriRef} cursorPosition={state.neriCursor} />
        </Suspense>
      )}
    </div>
  );
}




