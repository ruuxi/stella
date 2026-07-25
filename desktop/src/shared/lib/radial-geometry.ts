/**
 * Geometry for the radial dial, shared by every surface that draws or hit-tests
 * one.
 *
 * The dial is drawn three times over — as SVG annulus wedges, as absolutely
 * positioned icon/label boxes, and as a WebGL blob whose fragment shader
 * duplicates the same radii in normalized units. Hit-testing happens in two
 * more places again: the renderer highlights a wedge as the cursor moves, and a
 * driver commits one on release. Those five copies have to agree exactly or the
 * highlight and the committed selection drift apart, so the numbers and the
 * angle math live here rather than beside any one of them.
 *
 * Angle convention: index 0 starts at 12 o'clock and indices advance clockwise.
 *
 * Note the deliberate absence of an outer bound. Past the dead zone the dial is
 * an infinite pie: a cursor flung far outside the ring still selects the wedge
 * it points at, which is what makes a fast flick-and-release work. The only
 * no-selection release is one that ends inside the dead zone.
 */

import { RADIAL_SIZE } from "./layout";

export const RADIAL_DIAL_SIZE = RADIAL_SIZE;
export const RADIAL_CENTER = RADIAL_DIAL_SIZE / 2;
export const RADIAL_INNER_RADIUS = 40;
export const RADIAL_OUTER_RADIUS = 125;
export const RADIAL_DEAD_ZONE_RADIUS = 30;

/** Every dial is a four-wedge dial; the blob shader hardcodes this too. */
export const RADIAL_WEDGE_COUNT = 4;
export const RADIAL_WEDGE_ANGLE = 360 / RADIAL_WEDGE_COUNT;

/** Annulus sector path for one wedge, in the dial's own 280×280 space. */
export const createWedgePath = (
  startAngle: number,
  endAngle: number,
): string => {
  const startRad = (startAngle - 90) * (Math.PI / 180);
  const endRad = (endAngle - 90) * (Math.PI / 180);

  const x1 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.cos(startRad);
  const y1 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.sin(startRad);
  const x2 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.cos(startRad);
  const y2 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.sin(startRad);
  const x3 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.cos(endRad);
  const y3 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.sin(endRad);
  const x4 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.cos(endRad);
  const y4 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.sin(endRad);

  return `
    M ${x1} ${y1}
    L ${x2} ${y2}
    A ${RADIAL_OUTER_RADIUS} ${RADIAL_OUTER_RADIUS} 0 0 1 ${x3} ${y3}
    L ${x4} ${y4}
    A ${RADIAL_INNER_RADIUS} ${RADIAL_INNER_RADIUS} 0 0 0 ${x1} ${y1}
    Z
  `;
};

/** Where a wedge's icon and label sit: the middle of the annulus band. */
export const getWedgeContentPosition = (
  index: number,
): { x: number; y: number } => {
  const midAngle =
    (index * RADIAL_WEDGE_ANGLE + RADIAL_WEDGE_ANGLE / 2 - 90) *
    (Math.PI / 180);
  const contentRadius = (RADIAL_INNER_RADIUS + RADIAL_OUTER_RADIUS) / 2;
  return {
    x: RADIAL_CENTER + contentRadius * Math.cos(midAngle),
    y: RADIAL_CENTER + contentRadius * Math.sin(midAngle),
  };
};

/**
 * Which wedge a point selects, or `null` for no selection.
 *
 * `null` means the point is within the dead zone, which is how a release
 * dismisses without acting.
 */
export const getWedgeIndexAt = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
): number | null => {
  const dx = x - centerX;
  const dy = y - centerY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < RADIAL_DEAD_ZONE_RADIUS) return null;

  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  angle = (angle + 90) % 360;

  const index = Math.floor(angle / RADIAL_WEDGE_ANGLE);
  return index >= 0 && index < RADIAL_WEDGE_COUNT ? index : null;
};
