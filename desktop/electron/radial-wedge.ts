/**
 * Radial dial wedge calculation — shared between overlay controller and gesture service.
 */

export const RADIAL_WEDGES = ['capture', 'chat', 'add', 'voice'] as const
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

  // 4 wedges, each 90 degrees
  // Starting from top (-90 degrees / 270 degrees)
  // Adjust angle to start from top
  angle = (angle + 90) % 360

  // Determine wedge index
  const wedgeIndex = Math.floor(angle / 90)

  // Map: 0=Capture (top), 1=Chat (right), 2=Add (bottom), 3=Voice (left)
  return RADIAL_WEDGES[wedgeIndex] ?? 'dismiss'
}
