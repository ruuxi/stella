import { useEffect, useRef, useState, type MouseEvent } from "react";
import { getElectronApi } from "../services/electron";
import { runVacuumEffect } from "./region-capture-vacuum";

type Point = { x: number; y: number };

type VacuumState = {
  clickPoint: Point;
  bounds: { x: number; y: number; width: number; height: number };
  thumbnail: string;
};

const MIN_SELECTION_SIZE = 6;

export function RegionCapture() {
  const api = getElectronApi();
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [vacuum, setVacuum] = useState<VacuumState | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const selection = startPoint && currentPoint ? {
    x: Math.min(startPoint.x, currentPoint.x),
    y: Math.min(startPoint.y, currentPoint.y),
    width: Math.abs(startPoint.x - currentPoint.x),
    height: Math.abs(startPoint.y - currentPoint.y),
  } : null;

  const clearSelection = () => {
    setStartPoint(null);
    setCurrentPoint(null);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        getElectronApi()?.cancelRegionCapture?.();
        clearSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Listen for reset from main process (e.g. global Escape shortcut swallows
  // the keypress before the renderer's keydown handler fires).
  useEffect(() => {
    const cleanup = getElectronApi()?.onRegionReset?.(() => {
      clearSelection();
      setVacuum(null);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!vacuum || !canvasRef.current) return;
    const { clickPoint, bounds, thumbnail } = vacuum;
    const cx = (clickPoint.x - bounds.x) / bounds.width;
    const cy = (clickPoint.y - bounds.y) / bounds.height;

    runVacuumEffect(canvasRef.current, thumbnail, cx, cy).then(() => {
      api?.submitRegionClick?.(clickPoint);
      setVacuum(null);
    });
  }, [vacuum]);

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    api?.cancelRegionCapture?.();
    clearSelection();
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setStartPoint({ x: event.clientX, y: event.clientY });
    setCurrentPoint({ x: event.clientX, y: event.clientY });
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!startPoint) return;
    setCurrentPoint({ x: event.clientX, y: event.clientY });
  };

  const handleMouseUp = async (event: MouseEvent<HTMLDivElement>) => {
    if (!startPoint) return;
    event.preventDefault();
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
      clearSelection();
      const getWindowCapture = api?.getWindowCapture;
      if (!getWindowCapture) {
        api?.submitRegionClick?.(endPoint);
        return;
      }
      const capture = await getWindowCapture(endPoint);
      if (capture) {
        setVacuum({ clickPoint: endPoint, ...capture });
      } else {
        api?.submitRegionClick?.(endPoint);
      }
      return;
    }
    api?.submitRegionSelection?.(resolvedSelection);
    clearSelection();
  };

  return (
    <div
      className="region-capture-root"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      {!selection && !vacuum && <div className="region-capture-dim" />}
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
