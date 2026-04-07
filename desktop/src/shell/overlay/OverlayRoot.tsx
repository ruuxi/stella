import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
} from "react";
import { RadialDial } from "./RadialDial";
import { RegionCapture } from "./RegionCapture";
import { VoiceOverlay } from "@/shell/overlay/VoiceOverlay";
import { MorphTransition } from "@/shell/overlay/MorphTransition";
import { ScreenGuideAnnotations, type ScreenGuideAnnotation } from "@/shell/overlay/ScreenGuideAnnotations";
import "./overlays.css";

/**
 * OverlayRoot manages the unified transparent overlay window.
 *
 * All overlay components (Radial Dial, Region Capture, Mini Shell, and
 * floating overlay behavior) live as absolutely-positioned children.
 * The overlay window is hidden when idle and only shown when a component
 * activates, preventing it from blocking interaction with windows below.
 *
 * Hit-testing: the renderer tracks visible component bounding rects and
 * notifies the main process to toggle `setIgnoreMouseEvents` accordingly.
 */

type WindowBounds = { x: number; y: number; width: number; height: number };

type OverlayState = {
  radialVisible: boolean;
  radialPosition: { x: number; y: number } | null;
  radialCompactFocused: boolean;
  radialFullFocused: boolean;
  windowHighlightBounds: WindowBounds | null;
  regionCaptureActive: boolean;
  voiceVisible: boolean;
  voicePosition: { x: number; y: number } | null;
  screenGuideVisible: boolean;
  screenGuideAnnotations: ScreenGuideAnnotation[];
};

type OverlayAction =
  | {
      type: "radial:show";
      position?: { x: number; y: number };
      compactFocused?: boolean;
      fullFocused?: boolean;
    }
  | { type: "radial:hide" }
  | { type: "overlay:windowHighlight"; bounds: WindowBounds | null }
  | { type: "region"; active: boolean }
  | { type: "voice:show"; position: { x: number; y: number } }
  | { type: "voice:hide" }
  | { type: "screenGuide:show"; annotations: ScreenGuideAnnotation[] }
  | { type: "screenGuide:hide" };

function isSamePosition(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): boolean {
  return a?.x === b?.x && a?.y === b?.y;
}

const initialState: OverlayState = {
  radialVisible: false,
  radialPosition: null,
  radialCompactFocused: false,
  radialFullFocused: false,
  windowHighlightBounds: null,
  regionCaptureActive: false,
  voiceVisible: false,
  voicePosition: null,
  screenGuideVisible: false,
  screenGuideAnnotations: [],
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
      return {
        ...state,
        radialVisible: true,
        radialPosition: nextPosition,
        radialCompactFocused: action.compactFocused ?? false,
        radialFullFocused: action.fullFocused ?? false,
      };
    }
    case "radial:hide":
      return state.radialVisible
        ? { ...state, radialVisible: false, radialCompactFocused: false, radialFullFocused: false }
        : state;
    case "overlay:windowHighlight":
      return { ...state, windowHighlightBounds: action.bounds };
    case "region":
      return state.regionCaptureActive === action.active
        ? state
        : { ...state, regionCaptureActive: action.active };
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
    case "screenGuide:show":
      return { ...state, screenGuideVisible: true, screenGuideAnnotations: action.annotations };
    case "screenGuide:hide":
      return state.screenGuideVisible
        ? { ...state, screenGuideVisible: false, screenGuideAnnotations: [] }
        : state;
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
// Consolidates ALL IPC subscription effects (radial show/hide, region capture,
// mini show/hide/restore, voice show/hide) into a single hook.
// ---------------------------------------------------------------------------
function useOverlayIPC(
  dispatch: Dispatch<OverlayAction>,
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
          compactFocused?: boolean;
          fullFocused?: boolean;
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
            compactFocused: data.compactFocused,
            fullFocused: data.fullFocused,
          });
        } else {
          dispatch({
            type: "radial:show",
            compactFocused: data.compactFocused,
            fullFocused: data.fullFocused,
          });
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
    const cleanupWindowHighlight = api.overlay.onWindowHighlight?.((bounds) => {
      dispatch({ type: "overlay:windowHighlight", bounds });
    });

    return () => {
      if (radialHideTimerRef.current) {
        clearTimeout(radialHideTimerRef.current);
        radialHideTimerRef.current = null;
      }
      cleanupShow();
      cleanupHide();
      cleanupWindowHighlight?.();
    };
  }, [dispatch]);

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

  // Standalone voice overlay visibility/position.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupShow = api.overlay.onShowVoice?.(
      (data: { x: number; y: number; mode: "realtime" }) => {
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

  // Screen guide annotations.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupShow = api.overlay.onShowScreenGuide?.(
      (data: { annotations: ScreenGuideAnnotation[] }) => {
        dispatch({ type: "screenGuide:show", annotations: data.annotations });
      },
    );
    const cleanupHide = api.overlay.onHideScreenGuide?.(() => {
      dispatch({ type: "screenGuide:hide" });
    });

    return () => {
      cleanupShow?.();
      cleanupHide?.();
    };
  }, [dispatch]);

}

// ---------------------------------------------------------------------------
// Hook: useOverlayHitTesting
// Manages the overlay's setIgnoreMouseEvents toggle based on which overlay
// subsystems are currently active and whether the cursor is over an
// interactive region.
// ---------------------------------------------------------------------------
function useOverlayHitTesting(
  state: OverlayState,
  updateInteractive: (shouldBeInteractive: boolean) => void,
) {
  const {
    regionCaptureActive,
    radialVisible,
    voiceVisible,
    voicePosition,
    screenGuideVisible,
  } = state;
  const voiceX = voicePosition?.x ?? null;
  const voiceY = voicePosition?.y ?? null;

  useEffect(() => {
    if (regionCaptureActive) {
      updateInteractive(true);
      return;
    }

    if (radialVisible) {
      return;
    }

    if (!voiceVisible) {
      updateInteractive(false);
      return;
    }

    updateInteractive(false);

    const handleMouseMove = (e: MouseEvent) => {
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

      updateInteractive(isOverVoice);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [
    regionCaptureActive,
    radialVisible,
    voiceVisible,
    voiceX,
    voiceY,
    updateInteractive,
  ]);

  useEffect(() => {
    const anythingActive =
      radialVisible ||
      regionCaptureActive ||
      voiceVisible ||
      screenGuideVisible;

    if (!anythingActive) {
      updateInteractive(false);
    }
  }, [
    radialVisible,
    regionCaptureActive,
    voiceVisible,
    screenGuideVisible,
    updateInteractive,
  ]);
}

// ---------------------------------------------------------------------------
// Component: OverlayRoot
// Composes the hooks above and renders the overlay subsystem JSX.
// ---------------------------------------------------------------------------
export function OverlayRoot() {
  const [state, dispatch] = useReducer(overlayReducer, initialState);
  const interactiveRef = useRef<boolean | null>(null);
  const radialRef = useRef<HTMLDivElement>(null);

  useOverlayIPC(dispatch);

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

  useEffect(() => {
    interactiveRef.current = null;
  }, [
    state.radialVisible,
    state.regionCaptureActive,
    state.voiceVisible,
    state.screenGuideVisible,
  ]);

  useOverlayHitTesting(state, updateInteractive);

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
      {/* Window highlight ring: shown when a surface explicitly requests it,
          such as capture hover or the disabled Include badge hover. */}
      {state.windowHighlightBounds && (
        <div
          className="radial-window-ring"
          style={{
            left: state.windowHighlightBounds.x,
            top: state.windowHighlightBounds.y,
            width: state.windowHighlightBounds.width,
            height: state.windowHighlightBounds.height,
          }}
        />
      )}

      {/* Radial Dial: always mounted; visibility is managed via IPC.
          When not visible, position off-screen so the compositor's stale
          backing-store frame doesn't flash at the old position when the
          overlay window transitions from hidden → visible. */}
      <div
        ref={radialRef}
        className="radial-shell"
        style={{
          position: "absolute",
          zIndex: 2,
          left: state.radialVisible ? (state.radialPosition?.x ?? 0) : -9999,
          top: state.radialVisible ? (state.radialPosition?.y ?? 0) : -9999,
          width: 280,
          height: 280,
          pointerEvents: state.radialVisible ? "auto" : "none",
        }}
      >
        <RadialDial
          miniVisible={state.radialCompactFocused}
          fullVisible={state.radialFullFocused}
        />
      </div>

      {/* Region capture: mounted only when active. */}
      {state.regionCaptureActive && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 3,
            pointerEvents: "auto",
          }}
        >
          <RegionCapture />
        </div>
      )}

      <VoiceOverlay
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

      <ScreenGuideAnnotations
        annotations={state.screenGuideAnnotations}
        visible={state.screenGuideVisible}
        onDismiss={() => {
          dispatch({ type: "screenGuide:hide" });
          window.electronAPI?.overlay?.setInteractive(false);
        }}
      />

      <MorphTransition />
    </div>
  );
}

