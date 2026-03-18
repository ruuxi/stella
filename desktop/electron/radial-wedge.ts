/**
 * Radial dial wedge calculation — shared between overlay controller and gesture service.
 */

export const RADIAL_WEDGES = ['capture', 'chat', 'full', 'voice', 'auto'] as const
export type RadialWedge = (typeof RADIAL_WEDGES)[number] | 'dismiss'

const DEAD_ZONE_RADIUS = 30 // Larger center zone for "dismiss"

export const calculateSelectedWedge = (
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number
): RadialWedge => {
  const dx = cursorX - centerX
  const dy = cursorY - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)

  // Center zone = dismiss (cancel action)
  if (distance < DEAD_ZONE_RADIUS) {
    return 'dismiss'
  }

  // Calculate angle (0 = right, going clockwise)
  let angle = Math.atan2(dy, dx) * (180 / Math.PI)
  // Normalize to 0-360
  if (angle < 0) angle += 360

  // 5 wedges, each 72 degrees
  // Starting from top (-90 degrees / 270 degrees)
  // Adjust angle to start from top
  angle = (angle + 90) % 360

  // Determine wedge index
  const wedgeIndex = Math.floor(angle / 72)

  // Map: 0=Capture (top), 1=Chat (top-right), 2=Full (bottom-right), 3=Voice (bottom-left), 4=Auto (top-left)
  return RADIAL_WEDGES[wedgeIndex] ?? 'dismiss'
}
