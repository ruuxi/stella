import { useEffect, useState, type MouseEvent } from "react";
import { getElectronApi } from "../services/electron";

type Point = {
  x: number;
  y: number;
};

const MIN_SELECTION_SIZE = 6;

export function RegionCapture() {
  const api = getElectronApi();
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);

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

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    setStartPoint(point);
    setCurrentPoint(point);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!startPoint) {
      return;
    }
    setCurrentPoint({ x: event.clientX, y: event.clientY });
  };

  const handleMouseUp = () => {
    if (!startPoint) {
      return;
    }
    if (
      !selection ||
      selection.width < MIN_SELECTION_SIZE ||
      selection.height < MIN_SELECTION_SIZE
    ) {
      api?.cancelRegionCapture?.();
      clearSelection();
      return;
    }
    api?.submitRegionSelection?.(selection);
    clearSelection();
  };

  return (
    <div
      className="region-capture-root"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {!selection && <div className="region-capture-dim" />}
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
      <div className="region-capture-hint">Drag to capture region • Esc to cancel</div>
    </div>
  );
}
