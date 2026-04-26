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

export function RegionCapture() {
  const api = getElectronApi();
  const captureApi = api?.capture;
  const overlayApi = api?.overlay;
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [vacuum, setVacuum] = useState<VacuumState | null>(null);
  const [isPreparingCapture, setIsPreparingCapture] = useState(false);
  /** After the vacuum animation, keep the dim layer off until the overlay closes (avoids a flash while IPC runs). */
  const [dimSuppressedAfterVacuum, setDimSuppressedAfterVacuum] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverPointRef = useRef<Point | null>(null);
  const hoverPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selection = startPoint && currentPoint ? {
    x: Math.min(startPoint.x, currentPoint.x),
    y: Math.min(startPoint.y, currentPoint.y),
    width: Math.abs(startPoint.x - currentPoint.x),
    height: Math.abs(startPoint.y - currentPoint.y),
  } : null;

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
    overlayApi?.hideWindowHighlight?.();
  }, [overlayApi]);

  const previewWindowAtPoint = useCallback((point: Point) => {
    if (
      hoverPointRef.current &&
      hoverPointRef.current.x === point.x &&
      hoverPointRef.current.y === point.y
    ) {
      return;
    }
    hoverPointRef.current = point;
    if (hoverPreviewTimerRef.current) {
      clearTimeout(hoverPreviewTimerRef.current);
    }
    hoverPreviewTimerRef.current = setTimeout(() => {
      hoverPreviewTimerRef.current = null;
      overlayApi?.previewWindowHighlightAtPoint?.(point);
    }, 16);
  }, [overlayApi]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsPreparingCapture(false);
        captureApi?.cancelRegion?.();
        clearWindowPreview();
        clearSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [captureApi, clearSelection, clearWindowPreview]);

  useEffect(() => clearWindowPreview, [clearWindowPreview]);

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
    captureApi?.cancelRegion?.();
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
      {!selection && !vacuum && !isPreparingCapture && !dimSuppressedAfterVacuum && (
        <div className="region-capture-dim" />
      )}
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
      <div className="region-capture-hint">Click to capture window - drag to capture region - Right-click or Esc to cancel</div>
    </div>
  );
}
