/**
 * NativeOverlayController — Electron-side bridge to the native overlay process.
 *
 * Drop-in replacement for OverlayWindowController. Spawns the platform-specific
 * native overlay (D3D11 on Windows, Metal on macOS) and communicates via
 * stdin/stdout JSON lines.
 */

import { ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { screen } from 'electron'
import { RADIAL_SIZE } from '../layout-constants.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export class NativeOverlayController {
  private proc: ChildProcess | null = null
  private ready = false

  private activeRadial = false
  private activeMorph = false
  private activeVoice = false

  private radialBounds: { x: number; y: number } | null = null
  private interactiveReasons = new Set<string>()
  private morphDoneCallback: (() => void) | null = null
  private radialAnimDoneCallback: (() => void) | null = null
  private regionSelectCallback: ((sel: { x: number; y: number; width: number; height: number }) => void) | null = null
  private regionClickCallback: ((point: { x: number; y: number }) => void) | null = null
  private regionCancelCallback: (() => void) | null = null
  private displayChangeHandler: (() => void) | null = null

  constructor(private readonly exePath?: string) {}

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  create() {
    const exe = this.exePath ?? this.defaultExePath()
    if (!exe) {
      console.warn('[native-overlay] No native overlay binary found for this platform')
      return null
    }
    this.proc = spawn(exe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const rl = createInterface({ input: this.proc.stdout! })
    rl.on('line', (line) => {
      try { this.handleEvent(JSON.parse(line)) }
      catch { /* ignore malformed */ }
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      console.error('[native-overlay]', chunk.toString())
    })

    this.proc.on('error', (err) => {
      console.error('[native-overlay] spawn error:', err.message)
      this.proc = null
      this.ready = false
    })

    this.proc.on('exit', (code) => {
      console.log('[native-overlay] exited with code', code)
      this.proc = null
      this.ready = false
    })

    // Send initial display bounds and listen for display changes
    this.respanDisplays()
    this.displayChangeHandler = () => this.respanDisplays()
    screen.on('display-added', this.displayChangeHandler)
    screen.on('display-removed', this.displayChangeHandler)
    screen.on('display-metrics-changed', this.displayChangeHandler)

    return null // no BrowserWindow to return
  }

  getWindow() { return null }
  getOverlayOrigin() {
    const bounds = getAllDisplaysBounds()
    return { x: bounds.x, y: bounds.y }
  }

  /** Register a one-shot callback for when the native morph transition completes. */
  onMorphDone(cb: () => void) { this.morphDoneCallback = cb }

  /** Register a one-shot callback for when the native radial close animation completes. */
  onRadialDone(cb: () => void) { this.radialAnimDoneCallback = cb }

  /** Register callbacks for native region capture results. */
  onRegionSelect(cb: (sel: { x: number; y: number; width: number; height: number }) => void) { this.regionSelectCallback = cb }
  onRegionClick(cb: (point: { x: number; y: number }) => void) { this.regionClickCallback = cb }
  onRegionCancel(cb: () => void) { this.regionCancelCallback = cb }

  private defaultExePath(): string | null {
    const platformDir = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : process.platform
    const ext = process.platform === 'win32' ? '.exe' : ''
    const fileName = `stella_overlay${ext}`

    // At runtime __dirname is dist-electron/electron/windows/ — go up 3 levels to project root
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'native', 'out', platformDir, fileName),
      path.join(process.resourcesPath, 'native', 'out', platformDir, fileName),
    ]

    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return null
  }

  private send(msg: Record<string, unknown>) {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  private handleEvent(msg: Record<string, unknown>) {
    switch (msg.event) {
      case 'ready':
        this.ready = true
        break
      case 'radial_anim_done':
        this.activeRadial = false
        this.interactiveReasons.delete('radial')
        this.syncInteractive()
        this.radialAnimDoneCallback?.()
        this.radialAnimDoneCallback = null
        break
      case 'morph_done':
        this.activeMorph = false
        this.morphDoneCallback?.()
        this.morphDoneCallback = null
        break
      case 'region_select':
        this.interactiveReasons.delete('region')
        this.syncInteractive()
        this.regionSelectCallback?.({
          x: msg.x as number,
          y: msg.y as number,
          width: msg.w as number,
          height: msg.h as number,
        })
        break
      case 'region_click':
        this.interactiveReasons.delete('region')
        this.syncInteractive()
        this.regionClickCallback?.({ x: msg.x as number, y: msg.y as number })
        break
      case 'region_cancel':
        this.interactiveReasons.delete('region')
        this.syncInteractive()
        this.regionCancelCallback?.()
        break
    }
  }

  private respanDisplays() {
    const b = getAllDisplaysBounds()
    this.send({ cmd: 'respan', x: b.x, y: b.y, w: b.width, h: b.height })
  }

  private syncInteractive() {
    this.send({ cmd: 'set_interactive', value: this.interactiveReasons.size > 0 })
  }

  // ─── Radial Dial ─────────────────────────────────────────────────────────

  showRadial() {
    this.activeRadial = true
    this.interactiveReasons.add('radial')
    this.syncInteractive()

    const cursor = screen.getCursorScreenPoint()
    this.radialBounds = {
      x: Math.round(cursor.x - RADIAL_SIZE / 2),
      y: Math.round(cursor.y - RADIAL_SIZE / 2),
    }
    this.send({
      cmd: 'show_radial',
      x: cursor.x,
      y: cursor.y,
      size: RADIAL_SIZE,
    })
  }

  hideRadial() {
    this.send({ cmd: 'hide_radial' })
    this.radialBounds = null
    // interactive flag cleared when radial_anim_done event arrives
  }

  updateRadialCursor() {
    if (!this.radialBounds) return
    const cursor = screen.getCursorScreenPoint()
    this.send({ cmd: 'radial_cursor', x: cursor.x, y: cursor.y })
  }

  getRadialBounds() { return this.radialBounds }

  setRadialInteractive(interactive: boolean) {
    if (interactive) {
      this.interactiveReasons.add('radial')
    } else {
      this.interactiveReasons.delete('radial')
    }
    this.syncInteractive()
  }

  // ─── Voice ───────────────────────────────────────────────────────────────

  showVoice(screenX: number, screenY: number, mode: 'stt' | 'realtime') {
    this.activeVoice = true
    this.send({ cmd: 'show_voice', x: screenX, y: screenY, mode })
  }

  hideVoice() {
    this.activeVoice = false
    this.send({ cmd: 'hide_voice' })
  }

  /** Call at ~60fps while voice is active to drive creature animation. */
  updateVoiceState(listening: number, speaking: number, energy: number) {
    this.send({ cmd: 'voice_update', listening, speaking, energy })
  }

  /** Advance creature birth progress (0→1 over 12 seconds). */
  setCreatureBirth(value: number) {
    this.send({ cmd: 'creature_birth', value })
  }

  /** Trigger a flash effect on the creature. */
  triggerCreatureFlash() {
    this.send({ cmd: 'creature_flash' })
  }

  // ─── Morph Transition ────────────────────────────────────────────────────

  /**
   * Start a forward morph. Pass a file path to the screenshot PNG, not a data URL.
   * The native overlay loads the file directly.
   */
  startMorphForward(screenshotPath: string, bounds: { x: number; y: number; width: number; height: number }) {
    this.activeMorph = true
    this.send({
      cmd: 'morph_forward',
      screenshot: screenshotPath,
      x: bounds.x,
      y: bounds.y,
      w: bounds.width,
      h: bounds.height,
    })
  }

  startMorphReverse(screenshotPath: string) {
    this.send({ cmd: 'morph_reverse', screenshot: screenshotPath })
  }

  endMorph() {
    this.activeMorph = false
    this.send({ cmd: 'morph_end' })
  }

  // ─── Colors ──────────────────────────────────────────────────────────────

  /** Set colors for all components. Each array is flat [r,g,b, r,g,b, ...] */
  setColors(opts: { fills?: number[]; creature?: number[] }) {
    this.send({ cmd: 'set_colors', ...opts })
  }

  // ─── Modifier Block ──────────────────────────────────────────────────────

  showModifierBlock() {
    this.interactiveReasons.add('modifier')
    this.syncInteractive()
  }

  hideModifierBlock() {
    this.interactiveReasons.delete('modifier')
    this.syncInteractive()
  }

  // ─── Region Capture ─────────────────────────────────────────────────────

  startRegionCapture() {
    this.interactiveReasons.add('region')
    this.syncInteractive()
    this.send({ cmd: 'region_start' })
  }

  endRegionCapture() {
    this.send({ cmd: 'region_end' })
    this.interactiveReasons.delete('region')
    this.syncInteractive()
  }

  // ─── Mini Shell (stubs — mini is now a separate Chromium window) ────────

  showMini(_screenX: number, _screenY: number) {}
  hideMini() {}
  concealMiniForCapture() {}
  restoreMiniAfterCapture() {}

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  destroy() {
    if (this.displayChangeHandler) {
      screen.removeListener('display-added', this.displayChangeHandler)
      screen.removeListener('display-removed', this.displayChangeHandler)
      screen.removeListener('display-metrics-changed', this.displayChangeHandler)
      this.displayChangeHandler = null
    }
    if (this.proc) {
      this.send({ cmd: 'quit' })
      setTimeout(() => {
        this.proc?.kill()
        this.proc = null
      }, 500)
    }
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────

function getAllDisplaysBounds() {
  const displays = screen.getAllDisplays()
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x)
    minY = Math.min(minY, d.bounds.y)
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width)
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
