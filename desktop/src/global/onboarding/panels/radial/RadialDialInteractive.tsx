import { useId } from "react";
import { RADIAL_WEDGES } from "./data";

/**
 * Interactive SVG mirror of the real Stella radial dial.
 *
 * Geometry, wedge order, and visual hierarchy match
 * `desktop/src/shell/overlay/RadialDial.tsx`: 4 wedges (Capture, Chat,
 * Add, Voice) of 90° each, wedge 0 starting at the top and going
 * clockwise. Hovering / focusing a wedge calls `onSelect(index)`.
 */

const SIZE = 248;
const CENTER = SIZE / 2;
const INNER_RADIUS = 40;
const OUTER_RADIUS = 116;
const WEDGE_ANGLE = 90;

function polar(angleDeg: number, radius: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: CENTER + radius * Math.cos(rad),
    y: CENTER + radius * Math.sin(rad),
  };
}

function wedgePath(startAngle: number, endAngle: number) {
  const a = polar(startAngle, INNER_RADIUS);
  const b = polar(startAngle, OUTER_RADIUS);
  const c = polar(endAngle, OUTER_RADIUS);
  const d = polar(endAngle, INNER_RADIUS);
  return [
    `M ${a.x} ${a.y}`,
    `L ${b.x} ${b.y}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 0 1 ${c.x} ${c.y}`,
    `L ${d.x} ${d.y}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 0 0 ${a.x} ${a.y}`,
    "Z",
  ].join(" ");
}

function midPoint(index: number) {
  const mid = index * WEDGE_ANGLE + WEDGE_ANGLE / 2;
  return polar(mid, (INNER_RADIUS + OUTER_RADIUS) / 2);
}

const WEDGE_GEOMETRY = RADIAL_WEDGES.map((wedge, index) => {
  const start = index * WEDGE_ANGLE;
  const end = start + WEDGE_ANGLE;
  return {
    wedge,
    index,
    mid: midPoint(index),
    path: wedgePath(start, end),
  };
});

export function RadialDialInteractive({
  selectedIndex,
  onSelect,
  onPointerLeave,
}: {
  selectedIndex: number;
  onSelect: (index: number) => void;
  onPointerLeave?: () => void;
}) {
  const haloId = useId();

  return (
    <div className="radial-dial-interactive" onPointerLeave={onPointerLeave}>
      <div className="radial-dial-interactive__halo" aria-hidden="true" />

      <svg
        className="radial-dial-interactive__svg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="radiogroup"
        aria-label="Stella radial dial"
      >
        <defs>
          <radialGradient id={`${haloId}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(102, 178, 255, 0.45)" />
            <stop offset="60%" stopColor="rgba(102, 178, 255, 0.10)" />
            <stop offset="100%" stopColor="rgba(102, 178, 255, 0)" />
          </radialGradient>
        </defs>

        {WEDGE_GEOMETRY.map(({ wedge, index, mid, path }) => {
          const isSelected = index === selectedIndex;
          const Icon = wedge.icon;

          return (
            <g
              key={wedge.id}
              className="radial-dial-interactive__wedge"
              data-selected={isSelected || undefined}
              role="radio"
              aria-checked={isSelected}
              aria-label={wedge.label}
              tabIndex={0}
              onPointerEnter={() => onSelect(index)}
              onFocus={() => onSelect(index)}
              onClick={() => onSelect(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(index);
                }
              }}
            >
              <path d={path} className="radial-dial-interactive__wedge-fill" />
              <foreignObject
                x={mid.x - 28}
                y={mid.y - 22}
                width={56}
                height={44}
                style={{ pointerEvents: "none" }}
              >
                <div className="radial-dial-interactive__wedge-content">
                  <Icon size={16} aria-hidden="true" strokeWidth={2.1} />
                  <span>{wedge.label}</span>
                </div>
              </foreignObject>
            </g>
          );
        })}

        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_RADIUS - 4}
          fill={`url(#${haloId}-glow)`}
          style={{ pointerEvents: "none" }}
        />
      </svg>

      <div className="radial-dial-interactive__center" aria-hidden="true">
        <span className="radial-dial-interactive__center-mark">Stella</span>
      </div>
    </div>
  );
}
