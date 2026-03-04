import { useRef, useEffect, useMemo, useId } from "react";
import { lerpRgb } from "@/lib/color";
import { useSpinnerColors } from "@/hooks/use-theme-rgb";
import "./comet-spinner.css";

const CYCLE_DURATION_MS = 4000;
const SEGMENTS = 60;

type RGB = [number, number, number];

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
  const rawId = useId();
  const filterId = `comet-glow-${rawId.replace(/:/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);

  // Reactive theme colors via useTheme() — no MutationObserver needed
  const spinnerColors = useSpinnerColors();
  const colorsRef = useRef<RGB[]>(spinnerColors);
  useEffect(() => {
    colorsRef.current = spinnerColors;
  }, [spinnerColors]);

  const segmentGeo = useMemo(() => {
    const half = size / 2;
    const r = half - 2;
    const geo: Array<{
      x0: number; y0: number; x1: number; y1: number;
      strokeWidth: number; baseOpacity: number; progress: number;
    }> = [];

    for (let i = 0; i < SEGMENTS; i++) {
      const t0 = (i / SEGMENTS) * arcSpan;
      const t1 = ((i + 1) / SEGMENTS) * arcSpan;
      const angle0 = -Math.PI / 2 - t0 * 2 * Math.PI;
      const angle1 = -Math.PI / 2 - t1 * 2 * Math.PI;
      const progress = i / SEGMENTS;

      geo.push({
        x0: half + r * Math.cos(angle0),
        y0: half + r * Math.sin(angle0),
        x1: half + r * Math.cos(angle1),
        y1: half + r * Math.sin(angle1),
        strokeWidth: headWidth * (1 - progress),
        baseOpacity: 1 - progress * 0.85,
        progress,
      });
    }

    return {
      geo,
      headX: half + r * Math.cos(-Math.PI / 2),
      headY: half + r * Math.sin(-Math.PI / 2),
    };
  }, [size, arcSpan, headWidth]);

  // rAF animation loop — direct DOM mutation, bypasses React reconciliation
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const { geo } = segmentGeo;

    const tick = () => {
      const svg = svgRef.current;
      if (!svg) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const elapsed = performance.now() - start;
      const time = (elapsed % CYCLE_DURATION_MS) / CYCLE_DURATION_MS;
      const colors = colorsRef.current;

      const lines = svg.querySelectorAll<SVGLineElement>("line");
      for (let i = 0; i < lines.length; i++) {
        const pos = time - geo[i].progress * 0.4;
        lines[i].setAttribute("stroke", interpolateColor(colors, pos));
      }

      const circle = svg.querySelector<SVGCircleElement>("circle");
      if (circle) {
        circle.setAttribute("fill", interpolateColor(colors, time));
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [segmentGeo]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ animation: "selfmod-ring-spin 2s linear infinite" }}
    >
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {segmentGeo.geo.map((seg, i) => (
        <line
          key={i}
          x1={seg.x0}
          y1={seg.y0}
          x2={seg.x1}
          y2={seg.y1}
          strokeWidth={seg.strokeWidth}
          strokeLinecap="round"
          opacity={seg.baseOpacity}
        />
      ))}
      <circle
        cx={segmentGeo.headX}
        cy={segmentGeo.headY}
        r={2.5}
        filter={`url(#${filterId})`}
      />
    </svg>
  );
}
