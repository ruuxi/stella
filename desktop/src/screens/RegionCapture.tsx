import { useEffect, useState, useRef, useCallback, type MouseEvent } from "react";
import { getElectronApi } from "../services/electron";

type Point = { x: number; y: number };
type Ripple = { id: number; x: number; y: number; variant: "enter" | "click" };

const MIN_SELECTION_SIZE = 6;
const RIPPLE_ENTER_DURATION = 1100;
const RIPPLE_CLICK_DURATION = 700;
const CLICK_SUBMIT_DELAY = 280;

let nextRippleId = 0;

export function RegionCapture() {
  const api = getElectronApi();
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const timersRef = useRef<number[]>([]);

  const addRipple = useCallback((x: number, y: number, variant: Ripple["variant"]) => {
    const id = nextRippleId++;
    setRipples(prev => [...prev, { id, x, y, variant }]);
    const duration = variant === "enter" ? RIPPLE_ENTER_DURATION : RIPPLE_CLICK_DURATION;
    const timer = window.setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== id));
    }, duration + 100);
    timersRef.current.push(timer);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => timersRef.current.forEach(clearTimeout);
  }, []);

  // Entry ripple — 2 staggered waves from screen center
  useEffect(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    addRipple(cx, cy, "enter");
    const t = window.setTimeout(() => addRipple(cx, cy, "enter"), 200);
    timersRef.current.push(t);
    return () => clearTimeout(t);
  }, [addRipple]);

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

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    api?.cancelRegionCapture?.();
    clearSelection();
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    setStartPoint(point);
    setCurrentPoint(point);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!startPoint) return;
    setCurrentPoint({ x: event.clientX, y: event.clientY });
  };

  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
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
      addRipple(endPoint.x, endPoint.y, "click");
      clearSelection();
      // Brief delay so the ripple registers visually before the window hides
      const t = window.setTimeout(() => {
        api?.submitRegionClick?.(endPoint);
      }, CLICK_SUBMIT_DELAY);
      timersRef.current.push(t);
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

      {ripples.map(ripple => (
        <div
          key={ripple.id}
          className={`capture-ripple capture-ripple--${ripple.variant}`}
          style={{ left: ripple.x, top: ripple.y }}
        >
          <div className="capture-ripple-ring chromatic-r" />
          <div className="capture-ripple-ring chromatic-g" />
          <div className="capture-ripple-ring chromatic-b" />
        </div>
      ))}

      <div className="region-capture-hint">Click to capture window - drag to capture region - Right-click or Esc to cancel</div>
    </div>
  );
}
