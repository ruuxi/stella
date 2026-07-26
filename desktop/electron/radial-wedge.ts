/**
 * Radial dial wedge calculation — shared between overlay controller and gesture service.
 */

export const RADIAL_WEDGES = ['capture', 'chat', 'add', 'voice'] as const
export type RadialWedge = (typeof RADIAL_WEDGES)[number] | 'dismiss'

const DEAD_ZONE_RADIUS = 30 // Larger center zone for "dismiss"

/**
 * Which wedge index a cursor position selects, or `null` inside the dead
 * zone. Index 0 starts at 12 o'clock and advances clockwise — the same
 * convention as the renderer's `getWedgeIndexAt`, so highlight and commit
 * agree. Both dial variants (system chord and shell right-button) commit
 * through this.
 */
export const calculateSelectedWedgeIndex = (
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number
): number | null => {
  const dx = cursorX - centerX
  const dy = cursorY - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)

  // Center zone = dismiss (cancel action)
  if (distance < DEAD_ZONE_RADIUS) {
    return null
  }

  // Calculate angle (0 = right, going clockwise)
  let angle = Math.atan2(dy, dx) * (180 / Math.PI)
  // Normalize to 0-360
  if (angle < 0) angle += 360

  // 4 wedges, each 90 degrees, starting from top
  angle = (angle + 90) % 360

  const wedgeIndex = Math.floor(angle / 90)
  return wedgeIndex >= 0 && wedgeIndex < RADIAL_WEDGES.length
    ? wedgeIndex
    : null
}

export const calculateSelectedWedge = (
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number
): RadialWedge => {
  const index = calculateSelectedWedgeIndex(cursorX, cursorY, centerX, centerY)
  if (index === null) return 'dismiss'
  return RADIAL_WEDGES[index] ?? 'dismiss'
}
