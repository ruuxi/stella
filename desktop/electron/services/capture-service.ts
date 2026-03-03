import { desktopCapturer, screen, type BrowserWindow, type Display } from 'electron'
import { captureChatContext, type ChatContext } from '../chat-context.js'
import { hideModifierOverlay } from '../modifier-overlay.js'
import {
  createRegionCaptureWindow,
  getRegionCaptureWindow,
  hideRegionCaptureWindow,
  showRegionCaptureWindow,
} from '../region-capture-window.js'
import { hideRadialWindow } from '../radial-window.js'
import type {
  RegionCaptureResult,
  RegionSelection,
  ScreenshotCapture,
  UiState,
} from '../types.js'
import { toChatContextWindow } from '../types.js'
import { captureWindowScreenshot } from '../window-capture.js'

const CAPTURE_OVERLAY_HIDE_DELAY_MS = 80

type CaptureServiceOptions = {
  getAllWindows: () => BrowserWindow[]
  getMiniWindow: () => BrowserWindow | null
  isMiniShowing: () => boolean
  showWindow: (target: 'full' | 'mini') => void
  concealMiniWindowForCapture: () => boolean
  restoreMiniWindowAfterCapture: () => void
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

  constructor(private readonly options: CaptureServiceOptions) {}

  createRegionCaptureWindow() {
    createRegionCaptureWindow()
  }

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
    for (const window of this.options.getAllWindows()) {
      window.webContents.send('chatContext:updated', {
        context: this.pendingChatContext,
        version: this.chatContextVersion,
      })
    }
    this.lastBroadcastChatContextVersion = this.chatContextVersion
  }

  async waitForMiniChatContext(version: number, timeoutMs = 250) {
    if (!this.options.getMiniWindow()) {
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
  }

  setRadialContextShouldCommit(value: boolean) {
    this.radialContextShouldCommit = value
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
      regionScreenshots: screenshots,
    })
    this.stagedRadialChatContext = null
    this.radialContextShouldCommit = false

    if (this.options.isMiniShowing()) {
      this.broadcastChatContext()
    }
  }

  captureRadialContext(x: number, y: number, radialContextBeforeGesture: ChatContext | null) {
    const requestId = ++this.radialCaptureRequestId
    this.lastRadialPoint = { x, y }
    this.stagedRadialChatContext = null
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

  private async getDisplaySource(display: Display) {
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

  private resetRegionCapture() {
    this.pendingRegionCaptureResolve = null
    this.pendingRegionCapturePromise = null
    hideRegionCaptureWindow()
  }

  async startRegionCapture() {
    if (this.pendingRegionCapturePromise) {
      return this.pendingRegionCapturePromise
    }

    await showRegionCaptureWindow(() => {
      this.cancelRegionCapture()
    })

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
    hideRegionCaptureWindow()
    hideRadialWindow()
    hideModifierOverlay()
    const miniWasConcealed = this.options.concealMiniWindowForCapture()

    let screenshot: ScreenshotCapture | null = null
    try {
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))

      const regionBounds = getRegionCaptureWindow()?.getBounds()
      const globalX = (regionBounds?.x ?? 0) + selection.x
      const globalY = (regionBounds?.y ?? 0) + selection.y
      const centerX = globalX + selection.width / 2
      const centerY = globalY + selection.height / 2
      const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })

      const displayRelativeSelection = {
        x: globalX - display.bounds.x,
        y: globalY - display.bounds.y,
        width: selection.width,
        height: selection.height,
      }

      screenshot = await this.captureRegionScreenshot(display, displayRelativeSelection)
    } catch (error) {
      console.warn('Failed to capture selected region', error)
      screenshot = null
    } finally {
      if (miniWasConcealed) {
        this.options.restoreMiniWindowAfterCapture()
      }
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
    const regionBounds = getRegionCaptureWindow()?.getBounds()
    if (!regionBounds) return null

    const dipX = regionBounds.x + point.x
    const dipY = regionBounds.y + point.y
    const clickDisplay = screen.getDisplayNearestPoint({ x: dipX, y: dipY })
    const scaleFactor = process.platform === 'darwin' ? 1 : (clickDisplay.scaleFactor ?? 1)
    const screenX = Math.round(dipX * scaleFactor)
    const screenY = Math.round(dipY * scaleFactor)

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
    hideRegionCaptureWindow()
    hideRadialWindow()
    hideModifierOverlay()
    const miniWasConcealed = this.options.concealMiniWindowForCapture()

    let capture: Awaited<ReturnType<typeof captureWindowScreenshot>> = null
    try {
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))

      const regionBounds = getRegionCaptureWindow()?.getBounds()
      let capturePoint = { x: point.x, y: point.y }
      if (regionBounds) {
        const dipX = regionBounds.x + point.x
        const dipY = regionBounds.y + point.y
        const clickDisplay = screen.getDisplayNearestPoint({ x: dipX, y: dipY })
        const scaleFactor = process.platform === 'darwin' ? 1 : (clickDisplay.scaleFactor ?? 1)
        capturePoint = {
          x: Math.round(dipX * scaleFactor),
          y: Math.round(dipY * scaleFactor),
        }
      }

      capture = await captureWindowScreenshot(
        capturePoint.x,
        capturePoint.y,
        { excludePids: [process.pid] },
      )
    } catch (error) {
      console.warn('Failed to capture window at point', error)
      capture = null
    } finally {
      if (miniWasConcealed) {
        this.options.restoreMiniWindowAfterCapture()
      }
    }

    resolve({
      screenshot: capture?.screenshot ?? null,
      window: toChatContextWindow(capture?.windowInfo),
    })
    this.pendingRegionCaptureResolve = null
    this.pendingRegionCapturePromise = null
  }

  async captureScreenshot(point?: { x: number; y: number }) {
    const display = this.getDisplayForPoint(point)
    const cursorDip = point ?? screen.getCursorScreenPoint()
    const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)
    const capturePoint = {
      x: Math.round(cursorDip.x * scaleFactor),
      y: Math.round(cursorDip.y * scaleFactor),
    }
    hideRadialWindow()
    hideModifierOverlay()
    hideRegionCaptureWindow()
    const miniWasConcealed = this.options.concealMiniWindowForCapture()

    try {
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
      const windowCapture = await captureWindowScreenshot(
        capturePoint.x,
        capturePoint.y,
        { excludePids: [process.pid] },
      )
      if (windowCapture?.screenshot) {
        return windowCapture.screenshot
      }
      return await this.captureDisplayScreenshot(display)
    } finally {
      if (miniWasConcealed) {
        this.options.restoreMiniWindowAfterCapture()
      }
    }
  }
}
