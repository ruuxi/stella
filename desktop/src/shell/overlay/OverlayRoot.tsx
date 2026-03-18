import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
} from "react";
import { MINI_SHELL_SIZE } from "@/shared/lib/layout";
import { RadialDial } from "./RadialDial";
import { RegionCapture } from "./RegionCapture";
import { AutoPanel } from "./AutoPanel";
import { MiniShell } from "@/shell/mini/MiniShell";
import { VoiceOverlay } from "@/shell/overlay/VoiceOverlay";
import { MorphTransition } from "@/shell/overlay/MorphTransition";
import "./overlays.css";

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

type AutoPanelData = {
  x: number;
  y: number;
  width: number;
  height: number;
  windowText: string;
  windowTitle: string | null;
};

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
  autoPanel: AutoPanelData | null;
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
  | { type: "auto:show"; data: AutoPanelData }
  | { type: "auto:hide" };

function isSamePosition(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): boolean {
  return a?.x === b?.x && a?.y === b?.y;
}

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
  autoPanel: null,
};

function overlayReducer(
  state: OverlayState,
  action: OverlayAction,
): OverlayState {
  switch (action.type) {
    case "radial:show": {
      const nextPosition = action.position ?? state.radialPosition;
      if (
        state.radialVisible &&
        isSamePosition(state.radialPosition, nextPosition)
      ) {
        return state;
      }
      return { ...state, radialVisible: true, radialPosition: nextPosition };
    }
    case "radial:hide":
      return state.radialVisible ? { ...state, radialVisible: false } : state;
    case "modifier":
      return state.modifierBlock === action.active
        ? state
        : { ...state, modifierBlock: action.active };
    case "region":
      return state.regionCaptureActive === action.active
        ? state
        : { ...state, regionCaptureActive: action.active };
    case "mini:show":
      if (
        state.miniVisible &&
        isSamePosition(state.miniPosition, action.position)
      ) {
        return state;
      }
      return { ...state, miniVisible: true, miniPosition: action.position };
    case "mini:hide":
      return state.miniVisible ? { ...state, miniVisible: false } : state;
    case "mini:restore":
      return state.miniVisible ? state : { ...state, miniVisible: true };
    case "mini:position":
      return isSamePosition(state.miniPosition, action.position)
        ? state
        : { ...state, miniPosition: action.position };
    case "mini:preview":
      return state.miniPreviewVisible === action.visible
        ? state
        : { ...state, miniPreviewVisible: action.visible };
    case "voice:show":
      if (
        state.voiceVisible &&
        isSamePosition(state.voicePosition, action.position)
      ) {
        return state;
      }
      return { ...state, voiceVisible: true, voicePosition: action.position };
    case "voice:hide":
      return state.voiceVisible ? { ...state, voiceVisible: false } : state;
    case "auto:show":
      return { ...state, autoPanel: action.data };
    case "auto:hide":
      return state.autoPanel ? { ...state, autoPanel: null } : state;
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
function useOverlayIPC(
  dispatch: Dispatch<OverlayAction>,
  modifierBlock: boolean,
) {
  const radialHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Radial dial positioning (driven by radial:show/hide IPC).
  // The RadialDial component handles its own animation state via these same
  // IPC channels. OverlayRoot additionally tracks visibility and position
  // to control the container element's CSS and hit-testing.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // radial:show includes extra screenX/screenY for container positioning
    const cleanupShow = api.radial.onShow(
      (
        _event: unknown,
        data: {
          centerX: number;
          centerY: number;
          x?: number;
          y?: number;
          screenX?: number;
          screenY?: number;
        },
      ) => {
        if (radialHideTimerRef.current) {
          clearTimeout(radialHideTimerRef.current);
          radialHideTimerRef.current = null;
        }
        if (
          typeof data.screenX === "number" &&
          typeof data.screenY === "number"
        ) {
          dispatch({
            type: "radial:show",
            position: { x: data.screenX!, y: data.screenY! },
          });
        } else {
          dispatch({ type: "radial:show" });
        }
      },
    );
    const cleanupHide = api.radial.onHide(() => {
      // Do not immediately set radialVisible=false. The RadialDial plays a
      // close animation and calls radialAnimDone. We hide after a short delay
      // to let the animation complete.
      if (radialHideTimerRef.current) {
        clearTimeout(radialHideTimerRef.current);
      }
      radialHideTimerRef.current = setTimeout(() => {
        radialHideTimerRef.current = null;
        dispatch({ type: "radial:hide" });
      }, 300);
    });

    return () => {
      if (radialHideTimerRef.current) {
        clearTimeout(radialHideTimerRef.current);
        radialHideTimerRef.current = null;
      }
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

    const cleanup = api.overlay.onShowMini?.(
      (data: { x: number; y: number }) => {
        dispatch({ type: "mini:show", position: { x: data.x, y: data.y } });
      },
    );
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

    const cleanupShow = api.overlay.onShowVoice?.(
      (data: { x: number; y: number; mode: "stt" | "realtime" }) => {
        dispatch({ type: "voice:show", position: { x: data.x, y: data.y } });
      },
    );
    const cleanupHide = api.overlay.onHideVoice?.(() => {
      dispatch({ type: "voice:hide" });
    });

    return () => {
      cleanupShow?.();
      cleanupHide?.();
    };
  }, [dispatch]);

  // Auto panel visibility.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupShow = api.overlay.onShowAutoPanel?.((data) => {
      dispatch({ type: "auto:show", data });
    });
    const cleanupHide = api.overlay.onHideAutoPanel?.(() => {
      dispatch({ type: "auto:hide" });
    });
    return () => {
      cleanupShow?.();
      cleanupHide?.();
    };
  }, [dispatch]);
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
  const miniDragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const handleMiniTitlebarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only left button, only on the titlebar drag area (not buttons/inputs)
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Must be inside .mini-titlebar but not inside interactive child areas
      if (!target.closest(".mini-titlebar")) return;
      if (
        target.closest(
          ".mini-titlebar-left, .mini-titlebar-right, button, input, textarea",
        )
      )
        return;
      e.preventDefault();
      const el = miniRef.current;
      if (!el) return;
      miniDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: parseInt(el.style.left, 10) || 0,
        origY: parseInt(el.style.top, 10) || 0,
      };
    },
    [miniRef],
  );

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
  autoPanelRef: React.RefObject<HTMLDivElement | null>,
  updateInteractive: (shouldBeInteractive: boolean) => void,
) {
  const {
    regionCaptureActive,
    miniPreviewVisible,
    modifierBlock,
    radialVisible,
    miniVisible,
    voiceVisible,
    voicePosition,
    autoPanel,
  } = state;
  const voiceX = voicePosition?.x ?? null;
  const voiceY = voicePosition?.y ?? null;
  const autoPanelActive = autoPanel !== null;

  useEffect(() => {
    // When region capture is active, the entire overlay must be interactive
    if (regionCaptureActive) {
      updateInteractive(true);
      return;
    }

    // Screenshot preview behaves like a modal over the overlay; keep full hit-test enabled.
    if (miniPreviewVisible) {
      updateInteractive(true);
      return;
    }

    // When modifier block is active, the overlay must capture right-clicks
    if (modifierBlock) {
      updateInteractive(true);
      return;
    }

    // When radial is visible, main process handles interactivity directly
    if (radialVisible) {
      return;
    }

    // For mini shell, voice, and auto panel: only interactive when cursor
    // is over an active interactive region.
    if (!miniVisible && !voiceVisible && !autoPanelActive) {
      updateInteractive(false);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      let isOverMini = false;
      if (miniVisible) {
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
      if (voiceVisible && voiceX !== null && voiceY !== null) {
        const left = voiceX - VOICE_CREATURE_SIZE.width / 2;
        const top = voiceY - VOICE_CREATURE_SIZE.height / 2;
        isOverVoice =
          e.clientX >= left &&
          e.clientX <= left + VOICE_CREATURE_SIZE.width &&
          e.clientY >= top &&
          e.clientY <= top + VOICE_CREATURE_SIZE.height;
      }

      let isOverAutoPanel = false;
      if (autoPanelActive) {
        const autoPanelEl = autoPanelRef.current;
        if (autoPanelEl) {
          const rect = autoPanelEl.getBoundingClientRect();
          isOverAutoPanel =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
        }
      }

      updateInteractive(isOverMini || isOverVoice || isOverAutoPanel);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [
    regionCaptureActive,
    miniPreviewVisible,
    modifierBlock,
    radialVisible,
    miniVisible,
    voiceVisible,
    voiceX,
    voiceY,
    autoPanelActive,
    miniRef,
    autoPanelRef,
    updateInteractive,
  ]);

  useEffect(() => {
    const anythingActive =
      modifierBlock ||
      radialVisible ||
      regionCaptureActive ||
      miniPreviewVisible ||
      miniVisible ||
      voiceVisible ||
      autoPanelActive;

    if (!anythingActive) {
      updateInteractive(false);
    }
  }, [
    modifierBlock,
    radialVisible,
    regionCaptureActive,
    miniPreviewVisible,
    miniVisible,
    voiceVisible,
    autoPanelActive,
    updateInteractive,
  ]);
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
  const autoPanelRef = useRef<HTMLDivElement>(null);
  const miniDisplayed = state.miniVisible && !state.regionCaptureActive;

  // Wire up all IPC subscriptions (radial, modifier, region, mini, voice)
  useOverlayIPC(dispatch, state.modifierBlock);

  // Mini shell drag mechanics
  const { handleMiniTitlebarMouseDown } = useMiniDrag(miniRef, dispatch);

  // Interactivity / hit-testing management
  const updateInteractive = useCallback((shouldBeInteractive: boolean) => {
    if (interactiveRef.current === shouldBeInteractive) return;
    interactiveRef.current = shouldBeInteractive;
    // Safety check to ensure electronAPI is available and properly initialized
    if (
      typeof window !== "undefined" &&
      window.electronAPI?.overlay?.setInteractive
    ) {
      window.electronAPI.overlay.setInteractive(shouldBeInteractive);
    }
  }, []);

  useOverlayHitTesting(state, miniRef, autoPanelRef, updateInteractive);

  const handleMiniPreviewVisibilityChange = useCallback((visible: boolean) => {
    dispatch({ type: "mini:preview", visible });
  }, []);

  const handleVoiceTranscript = useCallback((transcript: string) => {
    window.electronAPI?.voice.submitTranscript?.(transcript);
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
        <MiniShell
          onPreviewVisibilityChange={handleMiniPreviewVisibilityChange}
        />
      </div>

      <VoiceOverlay
        onTranscript={handleVoiceTranscript}
        visible={state.voiceVisible && Boolean(state.voicePosition)}
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

      {/* Auto panel: right-side response panel for Auto mode */}
      {state.autoPanel && (
        <div
          ref={autoPanelRef}
          style={{
            position: "absolute",
            left: state.autoPanel.x,
            top: state.autoPanel.y,
            width: state.autoPanel.width,
            height: state.autoPanel.height,
            pointerEvents: "auto",
          }}
        >
          <AutoPanel
            windowText={state.autoPanel.windowText}
            windowTitle={state.autoPanel.windowTitle}
            onClose={() => {
              dispatch({ type: "auto:hide" });
              window.electronAPI?.overlay.hideAutoPanel?.();
            }}
          />
        </div>
      )}

      <MorphTransition />
    </div>
  );
}

