/**
 * The radial dial's appearance, with no opinion about what triggers it or what
 * a selection means.
 *
 * Three stacked layers: the WebGL blob that carries the open/close motion, the
 * Stella creature in the hub, and the SVG wedge ring with its icon/label boxes.
 * The blob is what you see while the dial is opening; the ring is what you see
 * once it is open.
 *
 * Callers own selection state and pass the highlighted wedge in. Nothing here
 * binds a pointer or key event — the overlay window's dial is driven by IPC
 * from a global chord, and the shell's by a right-button press, and neither
 * wants the other's input handling.
 */

import { useMemo, type ComponentType, type SVGProps } from "react";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";
import { cssToVec3 } from "@/shared/lib/color";
import {
  RADIAL_DIAL_SIZE,
  RADIAL_WEDGE_ANGLE,
  createWedgePath,
  getWedgeContentPosition,
} from "@/shared/lib/radial-geometry";
import { useTheme } from "@/context/theme-context";
import type { RadialDialPhase } from "./use-radial-dial-animation";
import "./radial-dial.css";

export type RadialDialWedge = {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>> | null;
  /**
   * Replaces the glyph when present. The overlay dial's Add wedge swaps in the
   * icon of whichever app sits under the cursor, which arrives asynchronously.
   */
  iconDataUrl?: string | null;
};

const toRgba = (color: string, alpha: number): string => {
  const [r, g, b] = cssToVec3(color);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
};

type RadialDialSurfaceProps = {
  wedges: readonly RadialDialWedge[];
  /** Highlighted wedge id, or `null` when the cursor is in the dead zone. */
  selectedId: string | null;
  phase: RadialDialPhase;
  contentVisible: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  reducedMotion: boolean;
};

export function RadialDialSurface({
  wedges,
  selectedId,
  phase,
  contentVisible,
  canvasRef,
  reducedMotion,
}: RadialDialSurfaceProps) {
  const { colors } = useTheme();

  const wedgeLayout = useMemo(
    () =>
      wedges.map((wedge, index) => ({
        ...wedge,
        contentPos: getWedgeContentPosition(index),
        path: createWedgePath(
          index * RADIAL_WEDGE_ANGLE,
          (index + 1) * RADIAL_WEDGE_ANGLE,
        ),
      })),
    [wedges],
  );

  const palette = useMemo(
    () => ({
      interactive: toRgba(colors.interactive, 1),
      interactiveStroke: toRgba(colors.interactive, 0.9),
      card: toRgba(colors.card, 1),
      border: toRgba(colors.border, 0.5),
    }),
    [colors.border, colors.card, colors.interactive],
  );

  const fadeTransition = reducedMotion
    ? "none"
    : phase === "closing"
      ? "opacity 0.1s ease-in"
      : "opacity 0.15s ease-out";
  const paintTransition = reducedMotion
    ? "none"
    : "fill 0.15s ease, stroke 0.15s ease";
  const colorTransition = reducedMotion ? "none" : "color 0.1s";

  return (
    <div className="radial-dial-container">
      <canvas
        ref={canvasRef}
        className="radial-blob-canvas"
        style={{
          width: RADIAL_DIAL_SIZE,
          height: RADIAL_DIAL_SIZE,
          opacity: phase !== "hidden" ? 1 : 0,
          pointerEvents: "none",
        }}
      />

      <div
        className="radial-center-stella-animation"
        style={{
          opacity: contentVisible ? 1 : 0,
          transition: fadeTransition,
        }}
      >
        <StellaAnimation
          width={20}
          height={20}
          initialBirthProgress={1}
          maxDpr={1}
          frameSkip={1}
          paused={!contentVisible}
        />
      </div>

      <div
        className="radial-dial-frame"
        style={{
          opacity: contentVisible ? 1 : 0,
          willChange: "opacity, transform",
          transition: fadeTransition,
          pointerEvents: "none",
        }}
      >
        <svg
          width={RADIAL_DIAL_SIZE}
          height={RADIAL_DIAL_SIZE}
          viewBox={`0 0 ${RADIAL_DIAL_SIZE} ${RADIAL_DIAL_SIZE}`}
          className="radial-dial"
        >
          {wedgeLayout.map((wedge) => {
            const isSelected = selectedId === wedge.id;
            return (
              <path
                key={wedge.id}
                d={wedge.path}
                fill={isSelected ? palette.interactive : palette.card}
                stroke={
                  isSelected ? palette.interactiveStroke : palette.border
                }
                strokeWidth={1.5}
                className="wedge-path"
                style={{ transition: paintTransition, cursor: "default" }}
              />
            );
          })}
        </svg>

        {wedgeLayout.map((wedge) => {
          const Icon = wedge.icon;
          const isSelected = selectedId === wedge.id;
          const appIcon = wedge.iconDataUrl ?? null;

          return (
            <div
              key={`${wedge.id}-content`}
              className="radial-wedge-content"
              style={{
                left: wedge.contentPos.x,
                top: wedge.contentPos.y,
                color: isSelected
                  ? colors.primaryForeground
                  : colors.mutedForeground,
              }}
            >
              {appIcon ? (
                <img
                  key={appIcon}
                  className="radial-wedge-app-icon"
                  src={appIcon}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                />
              ) : Icon ? (
                <Icon
                  aria-hidden="true"
                  width={16}
                  height={16}
                  style={{ transition: colorTransition }}
                />
              ) : null}
              {wedge.label ? (
                <span
                  className="radial-wedge-label"
                  style={{ transition: colorTransition }}
                >
                  {wedge.label}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
