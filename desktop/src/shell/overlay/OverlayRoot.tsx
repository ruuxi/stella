import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from "react";
import { RegionCapture } from "./RegionCapture";
import { MorphTransition } from "@/shell/overlay/MorphTransition";
import { InworldDictationSession } from "@/features/dictation/services/inworld-dictation";
import { appendRollingLevel } from "@/features/dictation/rolling-levels";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
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
  dictationVisible: boolean;
  dictationPosition: { x: number; y: number } | null;
};

type OverlayAction =
  | {
      type: "overlay:windowHighlight";
      bounds: WindowBounds | null;
      tone?: WindowHighlightTone;
    }
  | { type: "region"; active: boolean }
  | { type: "dictation:show"; position: { x: number; y: number } }
  | { type: "dictation:hide" };

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
  dictationVisible: false,
  dictationPosition: null,
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
        windowHighlightTone: action.bounds
          ? (action.tone ?? "default")
          : "default",
      };
    case "region":
      return state.regionCaptureActive === action.active
        ? state
        : {
            ...state,
            regionCaptureActive: action.active,
          };
    case "dictation:show":
      if (
        state.dictationVisible &&
        isSamePosition(state.dictationPosition, action.position)
      ) {
        return state;
      }
      return {
        ...state,
        dictationVisible: true,
        dictationPosition: action.position,
      };
    case "dictation:hide":
      return state.dictationVisible
        ? { ...state, dictationVisible: false }
        : state;
    default:
      return state;
  }
}

type InteractiveRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const pointInRect = (point: { x: number; y: number }, rect: InteractiveRect) =>
  point.x >= rect.left &&
  point.x <= rect.left + rect.width &&
  point.y >= rect.top &&
  point.y <= rect.top + rect.height;

// ---------------------------------------------------------------------------
// Hook: useOverlayIPC
// Consolidates ALL IPC subscription effects (window highlight, region capture,
// voice show/hide, screen guide) into a single hook.
// ---------------------------------------------------------------------------
function useOverlayIPC(dispatch: Dispatch<OverlayAction>) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanups = [
      api.overlay.onWindowHighlight?.((payload) => {
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
      }),
      api.overlay.onStartRegionCapture?.(() => {
        dispatch({
          type: "region",
          active: true,
        });
      }),
      api.overlay.onEndRegionCapture?.(() => {
        dispatch({ type: "region", active: false });
      }),
      api.overlay.onShowDictation?.((data: { x: number; y: number }) => {
        dispatch({
          type: "dictation:show",
          position: { x: data.x, y: data.y },
        });
      }),
      api.overlay.onHideDictation?.(() => {
        dispatch({ type: "dictation:hide" });
      }),
    ];

    return () => {
      for (const cleanup of cleanups) {
        cleanup?.();
      }
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
    dictationVisible,
    dictationPosition,
  } = state;

  useEffect(() => {
    if (regionCaptureActive) {
      updateInteractive(true);
      return;
    }

    if (!dictationVisible) {
      updateInteractive(false);
      return;
    }

    updateInteractive(false);

    const handleMouseMove = (e: MouseEvent) => {
      const rects: InteractiveRect[] = [];
      if (dictationVisible && dictationPosition) {
        rects.push({
          left: dictationPosition.x - DICTATION_OVERLAY_SIZE.width / 2,
          top: dictationPosition.y - DICTATION_OVERLAY_SIZE.height / 2,
          width: DICTATION_OVERLAY_SIZE.width,
          height: DICTATION_OVERLAY_SIZE.height,
        });
      }
      updateInteractive(
        rects.some((rect) => pointInRect({ x: e.clientX, y: e.clientY }, rect)),
      );
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [
    regionCaptureActive,
    dictationVisible,
    dictationPosition,
    updateInteractive,
  ]);

  useEffect(() => {
    const anythingActive = regionCaptureActive || dictationVisible;

    if (!anythingActive) {
      updateInteractive(false);
    }
  }, [
    regionCaptureActive,
    dictationVisible,
    updateInteractive,
  ]);
}

function useOverlayDictation() {
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const sessionRef = useRef<InworldDictationSession | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const transcriptRef = useRef("");
  const startedAtRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    sessionIdRef.current = null;
    transcriptRef.current = "";
    startedAtRef.current = null;
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    setLevels([]);
    setElapsedMs(0);
  }, []);

  const stopAndComplete = useCallback(
    async (sessionId: string) => {
      const session = sessionRef.current;
      if (!session || sessionIdRef.current !== sessionId) return;

      // Take ownership synchronously, before the first await, so a concurrent
      // second call (onOverlayStop + the confirm button both fire for the same
      // sessionId) fails the guard above instead of double-completing — which
      // would stop the session twice and send an empty transcript first,
      // dropping the real one.
      sessionRef.current = null;
      sessionIdRef.current = null;

      try {
        await session.stop();
        window.electronAPI?.dictation?.overlayCompleted({
          sessionId,
          text: transcriptRef.current,
        });
      } catch (error) {
        window.electronAPI?.dictation?.overlayFailed({
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearSession();
      }
    },
    [clearSession],
  );

  useEffect(() => {
    const api = window.electronAPI?.dictation;
    if (!api) return;

    const cleanupStart = api.onOverlayStart(({ sessionId }) => {
      const previous = sessionRef.current;
      if (previous) {
        void previous.cancel().catch(() => undefined);
        clearSession();
      }

      const session = new InworldDictationSession();
      sessionRef.current = session;
      sessionIdRef.current = sessionId;
      transcriptRef.current = "";
      startedAtRef.current = performance.now();
      setLevels([]);
      setElapsedMs(0);
      elapsedTimerRef.current = setInterval(() => {
        if (startedAtRef.current !== null) {
          setElapsedMs(performance.now() - startedAtRef.current);
        }
      }, 250);

      void session
        .start({
          onFinalTranscript: (text) => {
            transcriptRef.current = text;
          },
          onLevel: (level) => {
            setLevels((prev) =>
              appendRollingLevel(prev, level, MAX_DICTATION_OVERLAY_LEVELS),
            );
          },
          onStateChange: (state, error) => {
            if (state === "error") {
              window.electronAPI?.dictation?.overlayFailed({
                sessionId,
                error,
              });
              clearSession();
            }
          },
        })
        .then(() => {
          if (
            sessionRef.current !== session ||
            sessionIdRef.current !== sessionId
          ) {
            void session.cancel().catch(() => undefined);
          }
        })
        .catch((error) => {
          window.electronAPI?.dictation?.overlayFailed({
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          clearSession();
        });
    });

    const cleanupStop = api.onOverlayStop(({ sessionId }) => {
      void stopAndComplete(sessionId);
    });
    const cleanupCancel = api.onOverlayCancel?.(({ sessionId }) => {
      const session = sessionRef.current;
      if (!session || sessionIdRef.current !== sessionId) return;
      void session.cancel().finally(() => {
        window.electronAPI?.dictation?.overlayFailed({ sessionId });
        clearSession();
      });
    });

    return () => {
      cleanupStart();
      cleanupStop();
      cleanupCancel?.();
      const session = sessionRef.current;
      if (session) {
        void session.cancel().catch(() => undefined);
      }
      clearSession();
    };
  }, [clearSession, stopAndComplete]);

  const confirm = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void stopAndComplete(sessionId);
    }
  }, [stopAndComplete]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    const sessionId = sessionIdRef.current;
    if (!session || !sessionId) return;
    void session.cancel().finally(() => {
      window.electronAPI?.dictation?.overlayFailed({ sessionId });
      clearSession();
    });
  }, [clearSession]);

  return { levels, elapsedMs, confirm, cancel };
}

const MAX_DICTATION_OVERLAY_LEVELS = 96;
const DICTATION_OVERLAY_SIZE = {
  width: 300,
  height: 42,
} as const;

function DictationOverlay({
  visible,
  position,
  levels,
  elapsedMs,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  position: { x: number; y: number } | null;
  levels: number[];
  elapsedMs: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!visible || !position) return null;
  return (
    <div
      className="dictation-overlay"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      <DictationRecordingBar
        levels={levels}
        elapsedMs={elapsedMs}
        onCancel={onCancel}
        onConfirm={onConfirm}
        showControls={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: OverlayRoot
// Composes the hooks above and renders the overlay subsystem JSX.
// ---------------------------------------------------------------------------
export function OverlayRoot() {
  const [state, dispatch] = useReducer(overlayReducer, initialState);
  const interactiveRef = useRef<boolean | null>(null);

  useOverlayIPC(dispatch);
  const dictation = useOverlayDictation();

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
    state.dictationVisible,
  ]);

  useOverlayHitTesting(state, updateInteractive);

  return (
    <div
      className="overlay-root"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: state.regionCaptureActive ? "auto" : "none",
        overflow: "hidden",
      }}
    >
      {state.windowHighlightBounds && (
        <div
          className={
            state.windowHighlightTone === "subtle"
              ? "capture-window-ring capture-window-ring--subtle"
              : "capture-window-ring"
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

      <DictationOverlay
        visible={state.dictationVisible}
        position={state.dictationPosition}
        levels={dictation.levels}
        elapsedMs={dictation.elapsedMs}
        onCancel={dictation.cancel}
        onConfirm={dictation.confirm}
      />

      <MorphTransition />
    </div>
  );
}
