import { useRef, useEffect, useState, useCallback } from "react";
import "./comet-spinner.css";

const CYCLE_DURATION_MS = 4000;

const COLOR_VARS = [
  "--spinner-color-1",
  "--spinner-color-2",
  "--spinner-color-3",
  "--spinner-color-4",
];

type RGB = [number, number, number];

function parseRgb(color: string): RGB {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function lerpRgb(a: RGB, b: RGB, t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function resolveThemeColors(): RGB[] {
  const style = getComputedStyle(document.documentElement);
  return COLOR_VARS.map((v) => {
    const raw = style.getPropertyValue(v).trim();
    return raw ? parseRgb(raw) : ([128, 128, 128] as RGB);
  });
}

function interpolateColor(colors: RGB[], pos: number): string {
  const wrapped = ((pos % 1) + 1) % 1;
  const scaled = wrapped * colors.length;
  const index = Math.floor(scaled) % colors.length;
  const next = (index + 1) % colors.length;
  const t = scaled - Math.floor(scaled);
  return lerpRgb(colors[index], colors[next], t);
}

export interface CometSpinnerProps {
  /** Diameter in px. Default 96. */
  size?: number;
  /** Fraction of the circle the tail covers. Default 0.35. */
  arcSpan?: number;
  /** Stroke width at the head. Default 4. */
  headWidth?: number;
  className?: string;
}

export function CometSpinner({
  size = 96,
  arcSpan = 0.35,
  headWidth = 4,
  className,
}: CometSpinnerProps) {
  const segments = 60;
  const half = size / 2;
  const r = half - 2;

  const [colors, setColors] = useState<RGB[]>(() => resolveThemeColors());
  const [time, setTime] = useState(0);
  const rafRef = useRef(0);
  const startRef = useRef(0);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setColors(resolveThemeColors());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const tick = useCallback(() => {
    const elapsed = performance.now() - startRef.current;
    setTime((elapsed % CYCLE_DURATION_MS) / CYCLE_DURATION_MS);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    startRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tick]);

  const segmentGeo = [];
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * arcSpan;
    const t1 = ((i + 1) / segments) * arcSpan;
    const angle0 = -Math.PI / 2 - t0 * 2 * Math.PI;
    const angle1 = -Math.PI / 2 - t1 * 2 * Math.PI;
    const progress = i / segments;

    segmentGeo.push({
      x0: half + r * Math.cos(angle0),
      y0: half + r * Math.sin(angle0),
      x1: half + r * Math.cos(angle1),
      y1: half + r * Math.sin(angle1),
      strokeWidth: headWidth * (1 - progress),
      baseOpacity: 1 - progress * 0.85,
      progress,
    });
  }

  const headX = half + r * Math.cos(-Math.PI / 2);
  const headY = half + r * Math.sin(-Math.PI / 2);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ animation: "selfmod-ring-spin 2s linear infinite" }}
    >
      <defs>
        <filter id="comet-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {segmentGeo.map((seg, i) => {
        const pos = time - seg.progress * 0.4;
        return (
          <line
            key={i}
            x1={seg.x0}
            y1={seg.y0}
            x2={seg.x1}
            y2={seg.y1}
            stroke={interpolateColor(colors, pos)}
            strokeWidth={seg.strokeWidth}
            strokeLinecap="round"
            opacity={seg.baseOpacity}
          />
        );
      })}
      <circle
        cx={headX}
        cy={headY}
        r={2.5}
        fill={interpolateColor(colors, time)}
        filter="url(#comet-glow)"
      />
    </svg>
  );
}
