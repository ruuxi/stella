import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { getElectronApi } from "@/platform/electron/electron";
import { runVacuumEffect } from "./region-capture-vacuum";

type Point = { x: number; y: number };

type PreparedRegionCaptureResult = {
  screenshot: {
    dataUrl: string;
    width: number;
    height: number;
  } | null;
  window: {
    app: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  } | null;
};

type VacuumState = {
  clickPoint: Point;
  bounds: { x: number; y: number; width: number; height: number };
  thumbnail: string;
  result: PreparedRegionCaptureResult;
};

const MIN_SELECTION_SIZE = 6;
// Window-attach hover preview throttling. Each preview probe is a native
// `window_info` query on the main side (daemon pipe write, or a full
// CreateProcess on Windows when the daemon is down), so we cap at ~10/s
// (leading + trailing edge) instead of one-per-frame and skip probes when the
// cursor has barely moved since the last one — the highlight is still valid.
const HOVER_PREVIEW_DEBOUNCE_MS = 100;
const HOVER_PREVIEW_MOVE_THRESHOLD_PX = 6;
type RegionCaptureMode = "capture" | "window-attach";

export function RegionCapture({
  mode = "capture",
}: {
  mode?: RegionCaptureMode;
}) {
  const api = getElectronApi();
  const captureApi = api?.capture;
  const overlayApi = api?.overlay;
  const isWindowAttach = mode === "window-attach";
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [vacuum, setVacuum] = useState<VacuumState | null>(null);
  const [isPreparingCapture, setIsPreparingCapture] = useState(false);
  /** After the vacuum animation, keep the dim layer off until the overlay closes (avoids a flash while IPC runs). */
  const [dimSuppressedAfterVacuum, setDimSuppressedAfterVacuum] =
    useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverPointRef = useRef<Point | null>(null);
  const lastProbedPointRef = useRef<Point | null>(null);
  const lastProbeAtRef = useRef(0);
  const hoverPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const selection =
    startPoint && currentPoint
      ? {
          x: Math.min(startPoint.x, currentPoint.x),
          y: Math.min(startPoint.y, currentPoint.y),
          width: Math.abs(startPoint.x - currentPoint.x),
          height: Math.abs(startPoint.y - currentPoint.y),
        }
      : null;

  const clearSelection = useCallback(() => {
    setStartPoint(null);
    setCurrentPoint(null);
    setDimSuppressedAfterVacuum(false);
  }, []);

  const clearWindowPreview = useCallback(() => {
    if (hoverPreviewTimerRef.current) {
      clearTimeout(hoverPreviewTimerRef.current);
      hoverPreviewTimerRef.current = null;
    }
    hoverPointRef.current = null;
    lastProbedPointRef.current = null;
    overlayApi?.hideWindowHighlight?.();
  }, [overlayApi]);

  const probeLatestHoverPoint = useCallback(() => {
    const latest = hoverPointRef.current;
    if (!latest) return;
    const prev = lastProbedPointRef.current;
    if (
      prev &&
      Math.abs(prev.x - latest.x) + Math.abs(prev.y - latest.y) <
        HOVER_PREVIEW_MOVE_THRESHOLD_PX
    ) {
      // Cursor barely moved since the last probe — existing highlight is
      // still valid, so skip the spawn entirely.
      return;
    }
    lastProbedPointRef.current = latest;
    lastProbeAtRef.current = Date.now();
    overlayApi?.previewWindowHighlightAtPoint?.(latest);
  }, [overlayApi]);

  const previewWindowAtPoint = useCallback(
    (point: Point) => {
      hoverPointRef.current = point;
      // A trailing probe is already scheduled; it will pick up the latest
      // point when it fires, so don't stack a spawn per mouse-move event.
      if (hoverPreviewTimerRef.current) return;
      // Leading edge: when the probe budget allows, fire immediately so the
      // ring tracks the cursor without the trailing-debounce lag. Overall
      // rate stays capped at one probe per debounce window.
      if (Date.now() - lastProbeAtRef.current >= HOVER_PREVIEW_DEBOUNCE_MS) {
        probeLatestHoverPoint();
      }
      hoverPreviewTimerRef.current = setTimeout(() => {
        hoverPreviewTimerRef.current = null;
        probeLatestHoverPoint();
      }, HOVER_PREVIEW_DEBOUNCE_MS);
    },
    [probeLatestHoverPoint],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsPreparingCapture(false);
        if (isWindowAttach) {
          captureApi?.cancelWindowAttach?.();
        } else {
          captureApi?.cancelRegion?.();
        }
        clearWindowPreview();
        clearSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [captureApi, clearSelection, clearWindowPreview, isWindowAttach]);

  useEffect(() => {
    if (!vacuum || !canvasRef.current) return;
    const { clickPoint, bounds, thumbnail } = vacuum;
    const cx = (clickPoint.x - bounds.x) / bounds.width;
    const cy = (clickPoint.y - bounds.y) / bounds.height;
    let cancelled = false;

    runVacuumEffect(canvasRef.current, thumbnail, cx, cy).then(() => {
      if (cancelled) return;
      captureApi?.commitPreparedRegionCapture?.(vacuum.result);
      setDimSuppressedAfterVacuum(true);
      setIsPreparingCapture(false);
      setVacuum(null);
    });
    return () => {
      cancelled = true;
    };
  }, [vacuum, captureApi]);

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsPreparingCapture(false);
    if (isWindowAttach) {
      captureApi?.cancelWindowAttach?.();
    } else {
      captureApi?.cancelRegion?.();
    }
    clearWindowPreview();
    clearSelection();
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setIsPreparingCapture(false);
    clearWindowPreview();
    setStartPoint({ x: event.clientX, y: event.clientY });
    setCurrentPoint({ x: event.clientX, y: event.clientY });
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (isWindowAttach) {
      previewWindowAtPoint({ x: event.clientX, y: event.clientY });
      return;
    }
    if (!startPoint) {
      if (!vacuum) {
        previewWindowAtPoint({ x: event.clientX, y: event.clientY });
      }
      return;
    }
    const nextPoint = { x: event.clientX, y: event.clientY };
    setCurrentPoint((previousPoint) => {
      if (
        previousPoint &&
        previousPoint.x === nextPoint.x &&
        previousPoint.y === nextPoint.y
      ) {
        return previousPoint;
      }
      return nextPoint;
    });
  };

  const handleMouseUp = async (event: MouseEvent<HTMLDivElement>) => {
    if (!startPoint) return;
    event.preventDefault();
    clearWindowPreview();
    const endPoint = currentPoint ?? { x: event.clientX, y: event.clientY };
    if (isWindowAttach) {
      setIsPreparingCapture(true);
      clearWindowPreview();
      clearSelection();
      captureApi?.submitWindowAttachClick?.(endPoint);
      return;
    }

    const resolvedSelection = {
      x: Math.min(startPoint.x, endPoint.x),
      y: Math.min(startPoint.y, endPoint.y),
      width: Math.abs(startPoint.x - endPoint.x),
      height: Math.abs(startPoint.y - endPoint.y),
    };

    if (
      resolvedSelection.width < MIN_SELECTION_SIZE ||
      resolvedSelection.height < MIN_SELECTION_SIZE
    ) {
      setIsPreparingCapture(true);
      clearSelection();
      const getWindowCapture = captureApi?.getWindowCapture;
      if (!getWindowCapture) {
        captureApi?.submitRegionClick?.(endPoint);
        return;
      }
      const capture = await getWindowCapture(endPoint);
      if (capture) {
        setIsPreparingCapture(false);
        setVacuum({ clickPoint: endPoint, ...capture });
      } else {
        captureApi?.submitRegionClick?.(endPoint);
      }
      return;
    }
    const centerPoint = {
      x: resolvedSelection.x + Math.round(resolvedSelection.width / 2),
      y: resolvedSelection.y + Math.round(resolvedSelection.height / 2),
    };
    setIsPreparingCapture(true);
    clearSelection();
    const prepareRegionSelection = captureApi?.prepareRegionSelection;
    if (prepareRegionSelection) {
      const result = await prepareRegionSelection(resolvedSelection);
      if (result?.screenshot) {
        setIsPreparingCapture(false);
        setVacuum({
          clickPoint: centerPoint,
          bounds: resolvedSelection,
          thumbnail: result.screenshot.dataUrl,
          result,
        });
        return;
      }
    }
    captureApi?.submitRegionSelection?.(resolvedSelection);
  };

  return (
    <div
      className="region-capture-root"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      {!selection &&
        !vacuum &&
        !isPreparingCapture &&
        !dimSuppressedAfterVacuum && <div className="region-capture-dim" />}
      {selection && (
        <div
          className="region-capture-selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        />
      )}
      {vacuum && (
        <canvas
          ref={canvasRef}
          className="region-capture-vacuum"
          style={{
            left: vacuum.bounds.x,
            top: vacuum.bounds.y,
            width: vacuum.bounds.width,
            height: vacuum.bounds.height,
          }}
        />
      )}
      <div className="region-capture-hint">
        {isWindowAttach
          ? "Click a window to attach Stella - Right-click or Esc to cancel"
          : "Click to capture window - drag to capture region - Right-click or Esc to cancel"}
      </div>
    </div>
  );
}
