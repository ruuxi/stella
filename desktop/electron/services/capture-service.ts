import { desktopCapturer, screen, type BrowserWindow, type Display } from 'electron'
import { captureChatContext } from '../chat-context.js'
import { globalShortcut } from 'electron'
import type { ChatContext } from '../../src/shared/contracts/boundary.js'
import type {
  RegionCaptureResult,
  RegionSelection,
  ScreenshotCapture,
  UiState,
} from '../types.js'
import { toChatContextWindow } from '../types.js'
import { captureWindowScreenshot } from '../window-capture.js'
import { hasMacPermission } from '../utils/macos-permissions.js'

const CAPTURE_OVERLAY_HIDE_DELAY_MS = 80

export type CaptureWindowBridge = {
  getAllWindows: () => BrowserWindow[]
  getMiniWindow: () => BrowserWindow | null
  isMiniShowing: () => boolean
  showWindow: (target: 'full' | 'mini') => void
  concealMiniWindowForCapture: () => boolean
  restoreMiniWindowAfterCapture: () => void
}

export type CaptureOverlayBridge = {
  hideRadial: () => void
  startRegionCapture: () => void
  endRegionCapture: () => void
  getOverlayBounds: () => { x: number; y: number; width: number; height: number } | null
}

type CaptureServiceOptions = {
  window: CaptureWindowBridge
  overlay: CaptureOverlayBridge
  updateUiState: (partial: Partial<UiState>) => void
}

export class CaptureService {
  private pendingChatContext: ChatContext | null = null
  private chatContextVersion = 0
  private lastBroadcastChatContextVersion = -1
  private lastMiniChatContextAckVersion = -1
  private pendingMiniChatContextAck:
    | { version: number; resolve: () => void; timeout: NodeJS.Timeout }
    | null = null
  private lastRadialPoint: { x: number; y: number } | null = null
  private radialCaptureRequestId = 0
  private pendingRadialCapturePromise: Promise<void> | null = null
  private stagedRadialChatContext: ChatContext | null = null
  private radialContextShouldCommit = false
  private pendingRegionCaptureResolve: ((value: RegionCaptureResult | null) => void) | null = null
  private pendingRegionCapturePromise: Promise<RegionCaptureResult | null> | null = null
  private radialWindowContextEnabled = true

  constructor(private readonly options: CaptureServiceOptions) {}

  emptyContext(): ChatContext {
    return {
      window: null,
      browserUrl: null,
      selectedText: null,
      regionScreenshots: [],
    }
  }

  getChatContextSnapshot() {
    return this.pendingChatContext
  }

  setPendingChatContext(next: ChatContext | null) {
    this.pendingChatContext = next
    this.chatContextVersion += 1
  }

  getChatContextVersion() {
    return this.chatContextVersion
  }

  getLastBroadcastChatContextVersion() {
    return this.lastBroadcastChatContextVersion
  }

  broadcastChatContext() {
    for (const window of this.options.window.getAllWindows()) {
      window.webContents.send('chatContext:updated', {
        context: this.pendingChatContext,
        version: this.chatContextVersion,
      })
    }
    this.lastBroadcastChatContextVersion = this.chatContextVersion
  }

  async waitForMiniChatContext(version: number, timeoutMs = 250) {
    if (!this.options.window.getMiniWindow()) {
      return
    }
    if (this.lastMiniChatContextAckVersion >= version) {
      return
    }

    if (this.pendingMiniChatContextAck) {
      clearTimeout(this.pendingMiniChatContextAck.timeout)
      this.pendingMiniChatContextAck.resolve()
      this.pendingMiniChatContextAck = null
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingMiniChatContextAck?.version === version) {
          this.pendingMiniChatContextAck = null
        }
        resolve()
      }, timeoutMs)

      this.pendingMiniChatContextAck = {
        version,
        timeout,
        resolve: () => {
          clearTimeout(timeout)
          this.pendingMiniChatContextAck = null
          resolve()
        },
      }
    })
  }

  ackMiniChatContext(version: number) {
    this.lastMiniChatContextAckVersion = Math.max(this.lastMiniChatContextAckVersion, version)
    if (this.pendingMiniChatContextAck && this.pendingMiniChatContextAck.version === version) {
      this.pendingMiniChatContextAck.resolve()
    }
  }

  clearMiniChatContextAckWaiter() {
    if (this.pendingMiniChatContextAck) {
      clearTimeout(this.pendingMiniChatContextAck.timeout)
      this.pendingMiniChatContextAck.resolve()
      this.pendingMiniChatContextAck = null
    }
  }

  /** Preserves region screenshots but resets everything else to null. */
  clearTransientContext(): void {
    const current = this.pendingChatContext
    if (current?.regionScreenshots?.length) {
      this.setPendingChatContext({
        ...this.emptyContext(),
        regionScreenshots: current.regionScreenshots,
      })
    } else {
      this.setPendingChatContext(null)
    }
  }

  resetForHardReset() {
    this.clearMiniChatContextAckWaiter()
    this.setPendingChatContext(null)
    this.lastBroadcastChatContextVersion = -1
    this.lastMiniChatContextAckVersion = -1
    this.cancelRadialContextCapture()
    this.cancelRegionCapture()
  }

  removeScreenshot(index: number) {
    if (!this.pendingChatContext?.regionScreenshots) {
      return
    }
    const next = [...this.pendingChatContext.regionScreenshots]
    next.splice(index, 1)
    this.setPendingChatContext({ ...this.pendingChatContext, regionScreenshots: next })
  }

  cancelRadialContextCapture() {
    this.radialCaptureRequestId += 1
    this.pendingRadialCapturePromise = null
    this.stagedRadialChatContext = null
    this.radialContextShouldCommit = false
    this.radialWindowContextEnabled = true
  }

  setRadialContextShouldCommit(value: boolean) {
    this.radialContextShouldCommit = value
  }

  setRadialWindowContextEnabled(value: boolean) {
    this.radialWindowContextEnabled = value
  }

  commitStagedRadialContext(radialContextBeforeGesture: ChatContext | null) {
    if (!this.radialContextShouldCommit || !this.stagedRadialChatContext) {
      return
    }

    const screenshots =
      this.pendingChatContext?.regionScreenshots ??
      radialContextBeforeGesture?.regionScreenshots ??
      []

    this.setPendingChatContext({
      ...this.stagedRadialChatContext,
      windowContextEnabled: this.stagedRadialChatContext.window
        ? this.radialWindowContextEnabled
        : undefined,
      regionScreenshots: screenshots,
    })
    this.stagedRadialChatContext = null
    this.radialContextShouldCommit = false
    this.radialWindowContextEnabled = true

    if (this.options.window.isMiniShowing()) {
      this.broadcastChatContext()
    }
  }

  captureRadialContext(x: number, y: number, radialContextBeforeGesture: ChatContext | null) {
    const requestId = ++this.radialCaptureRequestId
    this.lastRadialPoint = { x, y }
    this.stagedRadialChatContext = null
    this.radialWindowContextEnabled = true
    const existingScreenshots =
      this.pendingChatContext?.regionScreenshots ??
      radialContextBeforeGesture?.regionScreenshots ??
      []

    this.pendingRadialCapturePromise = (async () => {
      try {
        const fresh = await captureChatContext(
          { x, y },
          { excludeCurrentProcessWindows: true },
        )
        if (requestId !== this.radialCaptureRequestId) {
          return
        }

        const screenshots = this.pendingChatContext?.regionScreenshots ?? existingScreenshots
        this.stagedRadialChatContext = {
          ...fresh,
          regionScreenshots: screenshots,
        }
      } catch (error) {
        if (requestId !== this.radialCaptureRequestId) {
          return
        }
        console.warn('Failed to capture chat context', error)
        const screenshots = this.pendingChatContext?.regionScreenshots ?? existingScreenshots
        this.stagedRadialChatContext = {
          window: null,
          browserUrl: null,
          selectedText: null,
          regionScreenshots: screenshots,
        }
      } finally {
        if (requestId === this.radialCaptureRequestId) {
          this.pendingRadialCapturePromise = null
          this.commitStagedRadialContext(radialContextBeforeGesture)
        }
      }
    })()
  }

  hasPendingRadialCapture() {
    return Boolean(this.pendingRadialCapturePromise)
  }

  private getDisplayForPoint(point?: { x: number; y: number }) {
    const targetPoint = point ?? this.lastRadialPoint ?? screen.getCursorScreenPoint()
    return screen.getDisplayNearestPoint(targetPoint)
  }

  private getDisplayScaleFactor(display: Display) {
    return process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)
  }

  private toNativeScreenPoint(point: { x: number; y: number }) {
    const display = screen.getDisplayNearestPoint(point)
    const scaleFactor = this.getDisplayScaleFactor(display)
    return {
      display,
      scaleFactor,
      x: Math.round(point.x * scaleFactor),
      y: Math.round(point.y * scaleFactor),
    }
  }

  private async getDisplaySource(display: Display) {
    if (!hasMacPermission('screen')) return null

    const scaleFactor = display.scaleFactor ?? 1
    const thumbnailSize = {
      width: Math.floor(display.size.width * scaleFactor),
      height: Math.floor(display.size.height * scaleFactor),
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
    })

    const preferred = sources.find((source) => source.display_id === String(display.id))
    const source = preferred ?? sources[0]
    if (!source) {
      return null
    }

    return { source, scaleFactor }
  }

  private async captureDisplayScreenshot(display: Display): Promise<ScreenshotCapture | null> {
    const result = await this.getDisplaySource(display)
    if (!result) return null

    const image = result.source.thumbnail
    const png = image.toPNG()
    const size = image.getSize()

    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: size.width,
      height: size.height,
    }
  }

  private async captureRegionScreenshot(
    display: Display,
    selection: RegionSelection,
  ): Promise<ScreenshotCapture | null> {
    const result = await this.getDisplaySource(display)
    if (!result) return null

    const image = result.source.thumbnail
    const size = image.getSize()
    const cropX = Math.max(0, Math.round(selection.x * result.scaleFactor))
    const cropY = Math.max(0, Math.round(selection.y * result.scaleFactor))
    const cropWidth = Math.min(size.width - cropX, Math.round(selection.width * result.scaleFactor))
    const cropHeight = Math.min(size.height - cropY, Math.round(selection.height * result.scaleFactor))

    if (cropWidth <= 0 || cropHeight <= 0) {
      return null
    }

    const cropped = image.crop({
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight,
    })
    const png = cropped.toPNG()
    const cropSize = cropped.getSize()

    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: cropSize.width,
      height: cropSize.height,
    }
  }

  /**
   * Hides overlay components, conceals the mini window, waits for the
   * compositor, runs `fn`, then restores the mini window. Centralises the
   * capture-preparation pattern shared by every capture path.
   */
  private async withCaptureContext<T>(fn: () => Promise<T>): Promise<T> {
    this.options.overlay.hideRadial()
    this.options.overlay.endRegionCapture()
    const miniWasConcealed = this.options.window.concealMiniWindowForCapture()

    try {
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
      return await fn()
    } finally {
      if (miniWasConcealed) {
        this.options.window.restoreMiniWindowAfterCapture()
      }
    }
  }

  /** Converts an overlay-relative point to native screen coordinates. */
  private toScreenPoint(overlayRelative: { x: number; y: number }): { x: number; y: number } {
    const regionBounds = this.options.overlay.getOverlayBounds()
    if (!regionBounds) return overlayRelative

    const dipX = regionBounds.x + overlayRelative.x
    const dipY = regionBounds.y + overlayRelative.y
    const { x, y } = this.toNativeScreenPoint({ x: dipX, y: dipY })
    return {
      x,
      y,
    }
  }

  private resetRegionCapture() {
    this.pendingRegionCaptureResolve = null
    this.pendingRegionCapturePromise = null
    try {
      globalShortcut.unregister('Escape')
    } catch {
      // Shortcut may already be gone if capture was interrupted externally.
    }
    this.options.overlay.endRegionCapture()
  }

  async startRegionCapture() {
    if (this.pendingRegionCapturePromise) {
      return this.pendingRegionCapturePromise
    }

    globalShortcut.register('Escape', () => {
      this.cancelRegionCapture()
    })

    this.options.overlay.startRegionCapture()

    this.pendingRegionCapturePromise = new Promise<RegionCaptureResult | null>((resolve) => {
      this.pendingRegionCaptureResolve = resolve
    })

    return this.pendingRegionCapturePromise
  }

  async finalizeRegionCapture(selection: RegionSelection) {
    if (!this.pendingRegionCaptureResolve) {
      this.resetRegionCapture()
      return
    }

    const resolve = this.pendingRegionCaptureResolve
    let screenshot: ScreenshotCapture | null = null

    try {
      screenshot = await this.withCaptureContext(async () => {
        const regionBounds = this.options.overlay.getOverlayBounds()
        const globalX = (regionBounds?.x ?? 0) + selection.x
        const globalY = (regionBounds?.y ?? 0) + selection.y
        const centerX = globalX + selection.width / 2
        const centerY = globalY + selection.height / 2
        const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })

        return this.captureRegionScreenshot(display, {
          x: globalX - display.bounds.x,
          y: globalY - display.bounds.y,
          width: selection.width,
          height: selection.height,
        })
      })
    } catch (error) {
      console.debug('[capture] region capture failed:', (error as Error).message)
    }

    resolve({ screenshot, window: null })
    this.resetRegionCapture()
  }

  cancelRegionCapture() {
    if (this.pendingRegionCaptureResolve) {
      this.pendingRegionCaptureResolve(null)
    }
    this.resetRegionCapture()
  }

  async getRegionWindowCapture(point: { x: number; y: number }) {
    const regionBounds = this.options.overlay.getOverlayBounds()
    if (!regionBounds) return null

    const dipX = regionBounds.x + point.x
    const dipY = regionBounds.y + point.y
    const { scaleFactor, x: screenX, y: screenY } =
      this.toNativeScreenPoint({ x: dipX, y: dipY })

    const capture = await captureWindowScreenshot(screenX, screenY, { excludePids: [process.pid] })
    if (!capture) return null

    const { bounds } = capture.windowInfo
    return {
      bounds: {
        x: Math.round(bounds.x / scaleFactor) - regionBounds.x,
        y: Math.round(bounds.y / scaleFactor) - regionBounds.y,
        width: Math.round(bounds.width / scaleFactor),
        height: Math.round(bounds.height / scaleFactor),
      },
      thumbnail: capture.screenshot.dataUrl,
    }
  }

  async handleRegionClick(point: { x: number; y: number }) {
    if (!this.pendingRegionCaptureResolve) {
      this.resetRegionCapture()
      return
    }

    const resolve = this.pendingRegionCaptureResolve
    let capture: Awaited<ReturnType<typeof captureWindowScreenshot>> = null

    try {
      capture = await this.withCaptureContext(async () => {
        const capturePoint = this.toScreenPoint(point)
        return captureWindowScreenshot(capturePoint.x, capturePoint.y, { excludePids: [process.pid] })
      })
    } catch (error) {
      console.debug('[capture] window capture at point failed:', (error as Error).message)
    }

    resolve({
      screenshot: capture?.screenshot ?? null,
      window: toChatContextWindow(capture?.windowInfo),
    })
    this.resetRegionCapture()
  }

  async captureScreenshot(point?: { x: number; y: number }) {
    const display = this.getDisplayForPoint(point)
    const cursorDip = point ?? screen.getCursorScreenPoint()
    const capturePoint = this.toNativeScreenPoint(cursorDip)

    return this.withCaptureContext(async () => {
      const windowCapture = await captureWindowScreenshot(
        capturePoint.x,
        capturePoint.y,
        { excludePids: [process.pid] },
      )
      if (windowCapture?.screenshot) {
        return windowCapture.screenshot
      }
      return this.captureDisplayScreenshot(display)
    })
  }
}
