import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.NODE_ENV === 'development'

const RADIAL_SIZE = 280 // Diameter of the radial dial

let radialWindow: BrowserWindow | null = null

const getDevUrl = () => {
  const url = new URL('http://localhost:5173')
  url.searchParams.set('window', 'radial')
  return url.toString()
}

const getFileTarget = () => ({
  filePath: path.join(__dirname, '../dist/index.html'),
  query: { window: 'radial' },
})

export const createRadialWindow = () => {
  if (radialWindow) return radialWindow

  radialWindow = new BrowserWindow({
    width: RADIAL_SIZE,
    height: RADIAL_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true, // Allow focus to help suppress native context menu
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Make window click-through when not interacting
  radialWindow.setIgnoreMouseEvents(false)

  if (isDev) {
    radialWindow.loadURL(getDevUrl())
  } else {
    const target = getFileTarget()
    radialWindow.loadFile(target.filePath, { query: target.query })
  }

  radialWindow.on('closed', () => {
    radialWindow = null
  })

  return radialWindow
}

export const showRadialWindow = (x: number, y: number) => {
  if (!radialWindow) {
    createRadialWindow()
  }

  if (!radialWindow) return

  // Get the display where the cursor is
  const cursorPoint = { x, y }
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const scaleFactor = display.scaleFactor ?? 1

  // Position window centered on cursor
  // Account for display scaling
  const adjustedX = Math.round(x / scaleFactor - RADIAL_SIZE / 2)
  const adjustedY = Math.round(y / scaleFactor - RADIAL_SIZE / 2)

  radialWindow.setBounds({
    x: adjustedX,
    y: adjustedY,
    width: RADIAL_SIZE,
    height: RADIAL_SIZE,
  })

  // Send cursor position to renderer (relative to window center)
  radialWindow.webContents.send('radial:show', {
    centerX: RADIAL_SIZE / 2,
    centerY: RADIAL_SIZE / 2,
  })

  radialWindow.show()
}

export const hideRadialWindow = () => {
  if (radialWindow) {
    radialWindow.webContents.send('radial:hide')
    radialWindow.hide()
  }
}

export const updateRadialCursor = (x: number, y: number) => {
  if (!radialWindow || !radialWindow.isVisible()) return

  // Get window bounds to calculate relative cursor position
  const bounds = radialWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x, y })
  const scaleFactor = display.scaleFactor ?? 1

  const relativeX = x / scaleFactor - bounds.x
  const relativeY = y / scaleFactor - bounds.y

  radialWindow.webContents.send('radial:cursor', {
    x: relativeX,
    y: relativeY,
    centerX: RADIAL_SIZE / 2,
    centerY: RADIAL_SIZE / 2,
  })
}

export const getRadialWindow = () => radialWindow

export const RADIAL_WEDGES = ['ask', 'chat', 'voice', 'full', 'menu'] as const
export type RadialWedge = (typeof RADIAL_WEDGES)[number]

const DEAD_ZONE_RADIUS = 15

export const calculateSelectedWedge = (
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number
): RadialWedge | null => {
  const dx = cursorX - centerX
  const dy = cursorY - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)

  // Small dead zone in center
  if (distance < DEAD_ZONE_RADIUS) {
    return null
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

  // Map: 0=Ask (top), 1=Chat (top-right), 2=Voice (bottom-right), 3=Full (bottom-left), 4=Menu (top-left)
  return RADIAL_WEDGES[wedgeIndex]
}
