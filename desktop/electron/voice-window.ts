import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDevServerUrl } from './dev-url.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.NODE_ENV === 'development'

const VOICE_WIDTH = 240
const VOICE_HEIGHT = 80

let voiceWindow: BrowserWindow | null = null

const getDevUrl = () => {
  const url = new URL(getDevServerUrl())
  url.searchParams.set('window', 'voice')
  return url.toString()
}

const getProdTarget = () => ({
  filePath: path.join(__dirname, '../dist/index.html'),
  query: { window: 'voice' },
})

export const createVoiceWindow = () => {
  if (voiceWindow) return voiceWindow

  voiceWindow = new BrowserWindow({
    width: VOICE_WIDTH,
    height: VOICE_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:Stella',
    },
  })

  voiceWindow.setAlwaysOnTop(true, 'pop-up-menu')

  if (isDev) {
    voiceWindow.loadURL(getDevUrl())
  } else {
    const target = getProdTarget()
    voiceWindow.loadFile(target.filePath, { query: target.query })
  }

  voiceWindow.on('closed', () => {
    voiceWindow = null
  })

  return voiceWindow
}

export const showVoiceWindow = () => {
  if (!voiceWindow) {
    createVoiceWindow()
  }
  if (!voiceWindow) return

  // Position at bottom center of the primary display (or current display)
  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)
  
  const width = Math.round(VOICE_WIDTH / scaleFactor)
  const height = Math.round(VOICE_HEIGHT / scaleFactor)
  
  const x = display.bounds.x + Math.round((display.bounds.width - width) / 2)
  const y = display.bounds.y + display.bounds.height - height - Math.round(40 / scaleFactor)

  voiceWindow.setBounds({ x, y, width, height })
  voiceWindow.setOpacity(1)
  voiceWindow.showInactive()
}

export const hideVoiceWindow = () => {
  if (voiceWindow) {
    voiceWindow.hide()
  }
}

export const getVoiceWindow = () => voiceWindow
