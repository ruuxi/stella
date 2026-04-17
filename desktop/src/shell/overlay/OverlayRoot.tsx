import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
} from "react";
import { RegionCapture } from "./RegionCapture";
import { VoiceOverlay } from "@/shell/overlay/VoiceOverlay";
import { MorphTransition } from "@/shell/overlay/MorphTransition";
import { ScreenGuideAnnotations, type ScreenGuideAnnotation } from "@/shell/overlay/ScreenGuideAnnotations";
import "./overlays.css";

/**
 * OverlayRoot manages the unified transparent overlay window.
 *
 * All overlay components (Region Capture, Voice Overlay, Screen Guide,
 * Window Highlight, and Morph Transition) live as absolutely-positioned
 * children. The overlay window is hidden when idle and only shown when a
 * component activates, preventing it from blocking interaction with windows
 * below.
 *
 * Hit-testing: the renderer tracks visible component bounding rects and
 * notifies the main process to toggle `setIgnoreMouseEvents` accordingly.
 */

type WindowBounds = { x: number; y: number; width: number; height: number };
type WindowHighlightTone = "default" | "subtle";

type OverlayState = {
  windowHighlightBounds: WindowBounds | null;
  windowHighlightTone: WindowHighlightTone;
  regionCaptureActive: boolean;
  voiceVisible: boolean;
  voicePosition: { x: number; y: number } | null;
  screenGuideVisible: boolean;
  screenGuideAnnotations: ScreenGuideAnnotation[];
};

type OverlayAction =
  | {
      type: "overlay:windowHighlight";
      bounds: WindowBounds | null;
      tone?: WindowHighlightTone;
    }
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
  windowHighlightBounds: null,
  windowHighlightTone: "default",
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
    case "overlay:windowHighlight":
      return {
        ...state,
        windowHighlightBounds: action.bounds,
        windowHighlightTone: action.bounds ? (action.tone ?? "default") : "default",
      };
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
// Consolidates ALL IPC subscription effects (window highlight, region capture,
// voice show/hide, screen guide) into a single hook.
// ---------------------------------------------------------------------------
function useOverlayIPC(
  dispatch: Dispatch<OverlayAction>,
) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupWindowHighlight = api.overlay.onWindowHighlight?.((payload) => {
      dispatch({
        type: "overlay:windowHighlight",
        bounds: payload
          ? {
              x: payload.x,
              y: payload.y,
              width: payload.width,
              height: payload.height,
            }
          : null,
        tone: payload?.tone,
      });
    });

    return () => {
      cleanupWindowHighlight?.();
    };
  }, [dispatch]);

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
    voiceVisible,
    voiceX,
    voiceY,
    updateInteractive,
  ]);

  useEffect(() => {
    const anythingActive =
      regionCaptureActive ||
      voiceVisible ||
      screenGuideVisible;

    if (!anythingActive) {
      updateInteractive(false);
    }
  }, [
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

  useOverlayIPC(dispatch);

  const updateInteractive = useCallback((shouldBeInteractive: boolean) => {
    if (interactiveRef.current === shouldBeInteractive) return;
    interactiveRef.current = shouldBeInteractive;
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
      {state.windowHighlightBounds && (
        <div
          className={
            state.windowHighlightTone === "subtle"
              ? "radial-window-ring radial-window-ring--subtle"
              : "radial-window-ring"
          }
          style={{
            left: state.windowHighlightBounds.x,
            top: state.windowHighlightBounds.y,
            width: state.windowHighlightBounds.width,
            height: state.windowHighlightBounds.height,
          }}
        />
      )}

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
