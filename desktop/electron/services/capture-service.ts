import {
  desktopCapturer,
  screen,
  type BrowserWindow,
  type Display,
  type NativeImage,
} from 'electron'
import { globalShortcut } from 'electron'
import type { ChatContext } from '../../../runtime/contracts/index.js'
import type {
  RegionCaptureResult,
  RegionSelection,
  ScreenshotCapture,
  UiState,
  VisionDisplayCapture,
  VisionScreenshotCapture,
} from '../types.js'
import { toChatContextWindow } from '../types.js'
import {
  STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES,
  captureRegionScreenshotNative,
  captureWindowScreenshot,
} from '../window-capture.js'
import { IPC_CAPTURE_REGION_FAILED } from '../../src/shared/contracts/ipc-channels.js'
import { hasMacPermission } from '../utils/macos-permissions.js'
import { computeTargetDims } from '../vision-coordinate-space.js'

const CAPTURE_OVERLAY_HIDE_DELAY_MS = 80

export type CaptureWindowBridge = {
  getAllWindows: () => BrowserWindow[]
}

export type CaptureOverlayBridge = {
  startRegionCapture: () => void | Promise<void>
  endRegionCapture: () => void
  suspendRegionCaptureForScreenshot: () => void
  restoreRegionCaptureAfterScreenshot: () => void
  getOverlayBounds: () => {
    x: number
    y: number
    width: number
    height: number
  } | null
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
  private pendingRegionCaptureResolve:
    | ((value: RegionCaptureResult | null) => void)
    | null = null
  private pendingRegionCapturePromise: Promise<RegionCaptureResult | null> | null =
    null

  constructor(private readonly options: CaptureServiceOptions) {}

  emptyContext(): ChatContext {
    return {
      window: null,
      browserUrl: null,
      selectedText: null,
      windowAxTree: null,
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

  broadcastChatContext() {
    for (const window of this.options.window.getAllWindows()) {
      window.webContents.send('chatContext:updated', {
        context: this.pendingChatContext,
        version: this.chatContextVersion,
      })
    }
    this.lastBroadcastChatContextVersion = this.chatContextVersion
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
    this.setPendingChatContext(null)
    this.lastBroadcastChatContextVersion = -1
    this.cancelRegionCapture()
  }

  removeScreenshot(index: number) {
    if (!this.pendingChatContext?.regionScreenshots) {
      return
    }
    const next = [...this.pendingChatContext.regionScreenshots]
    next.splice(index, 1)
    this.setPendingChatContext({
      ...this.pendingChatContext,
      regionScreenshots: next,
    })
  }

  /**
   * Merge a finished capture into the pending chat context, surfacing an
   * error to the renderer when the flow completed but produced nothing
   * (native capture failed end-to-end). A `null` result means the user
   * cancelled — stays silent.
   */
  commitRegionCaptureResult(result: RegionCaptureResult | null): boolean {
    if (result === null) {
      return false
    }
    const merged = this.mergeRegionCaptureResult(result)
    if (!merged) {
      for (const window of this.options.window.getAllWindows()) {
        window.webContents.send(IPC_CAPTURE_REGION_FAILED)
      }
    }
    return merged
  }

  mergeRegionCaptureResult(result: RegionCaptureResult | null): boolean {
    if (!result || (!result.screenshot && !result.window)) {
      return false
    }

    const ctx = this.getChatContextSnapshot() ?? this.emptyContext()
    const isWindowClick = Boolean(result.window && result.screenshot)
    const isRegionSelection = Boolean(result.screenshot && !result.window)
    const existing = ctx.regionScreenshots ?? []

    // Always append: when a new window screenshot arrives (window-click) and
    // an existing window screenshot is already attached, push the old one
    // onto regionScreenshots so it survives as a stacked chip rather than
    // being replaced silently. Plain region selections also append and must
    // NOT clear the existing window context.
    const carriedPreviousWindowShot =
      isWindowClick && ctx.windowScreenshot ? [ctx.windowScreenshot] : []
    const nextScreenshots = result.screenshot
      ? isWindowClick
        ? [...existing, ...carriedPreviousWindowShot]
        : [...existing, result.screenshot]
      : existing

    const nextWindow = isWindowClick ? result.window : ctx.window
    const nextWindowScreenshot = isWindowClick
      ? result.screenshot
      : (ctx.windowScreenshot ?? null)

    this.setPendingChatContext({
      ...ctx,
      window: nextWindow,
      windowScreenshot: nextWindowScreenshot,
      windowContextEnabled: isRegionSelection
        ? ctx.windowContextEnabled
        : result.window
          ? undefined
          : ctx.windowContextEnabled,
      regionScreenshots: nextScreenshots,
    })
    this.broadcastChatContext()
    return true
  }

  private getDisplayForPoint(point?: { x: number; y: number }) {
    const targetPoint = point ?? screen.getCursorScreenPoint()
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

    const pickSource = (sources: Electron.DesktopCapturerSource[]) => {
      const preferred = sources.find(
        (source) => source.display_id === String(display.id),
      )
      return preferred ?? sources[0] ?? null
    }

    let sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
    })
    let source = pickSource(sources)

    // A short retry lets the compositor settle when desktopCapturer initially
    // returns an empty source or an unpopulated thumbnail.
    if (!source || source.thumbnail.isEmpty()) {
      await new Promise((r) => setTimeout(r, 120))
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
      })
      source = pickSource(sources)
    }

    if (!source) {
      return null
    }

    return { source, scaleFactor }
  }

  private buildVisionScreenshotFromImage(
    image: NativeImage,
    logicalBounds: { x: number; y: number; width: number; height: number },
  ): VisionScreenshotCapture {
    const sourceSize = image.getSize()
    const scaleFactorX =
      logicalBounds.width > 0 ? sourceSize.width / logicalBounds.width : 1
    const scaleFactorY =
      logicalBounds.height > 0 ? sourceSize.height / logicalBounds.height : 1
    const scaleFactor = Math.max(scaleFactorX, scaleFactorY, 1)
    const [targetWidth, targetHeight] = computeTargetDims(
      logicalBounds.width,
      logicalBounds.height,
      scaleFactor,
    )
    const resized =
      sourceSize.width === targetWidth && sourceSize.height === targetHeight
        ? image
        : image.resize({
            width: targetWidth,
            height: targetHeight,
            quality: 'good',
          })

    return {
      dataUrl: resized.toDataURL(),
      width: targetWidth,
      height: targetHeight,
      coordinateSpace: {
        x: logicalBounds.x,
        y: logicalBounds.y,
        logicalWidth: logicalBounds.width,
        logicalHeight: logicalBounds.height,
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height,
        targetWidth,
        targetHeight,
      },
    }
  }

  private async captureDisplayScreenshot(
    display: Display,
  ): Promise<ScreenshotCapture | null> {
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
    // Windows: BitBlt just the selected rect from the screen DC (native helper)
    // instead of capturing every display at full resolution and cropping. Falls
    // through to desktopCapturer below when the native path is unavailable.
    if (process.platform === 'win32') {
      const scaleFactor = this.getDisplayScaleFactor(display)
      const native = await captureRegionScreenshotNative(
        (display.bounds.x + selection.x) * scaleFactor,
        (display.bounds.y + selection.y) * scaleFactor,
        selection.width * scaleFactor,
        selection.height * scaleFactor,
      )
      if (native) return native
    }

    const result = await this.getDisplaySource(display)
    if (!result) return null

    const image = result.source.thumbnail
    const size = image.getSize()
    const cropX = Math.max(0, Math.round(selection.x * result.scaleFactor))
    const cropY = Math.max(0, Math.round(selection.y * result.scaleFactor))
    const cropWidth = Math.min(
      size.width - cropX,
      Math.round(selection.width * result.scaleFactor),
    )
    const cropHeight = Math.min(
      size.height - cropY,
      Math.round(selection.height * result.scaleFactor),
    )

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

  private async withCaptureContext<T>(fn: () => Promise<T>): Promise<T> {
    this.options.overlay.endRegionCapture()
    await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
    return await fn()
  }

  private async withSuspendedRegionCapture<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    this.options.overlay.suspendRegionCaptureForScreenshot()
    await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
    try {
      return await fn()
    } finally {
      this.options.overlay.restoreRegionCaptureAfterScreenshot()
    }
  }

  /** Converts an overlay-relative point to native screen coordinates. */
  private toScreenPoint(overlayRelative: { x: number; y: number }): {
    x: number
    y: number
  } {
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

    this.pendingRegionCapturePromise = new Promise<RegionCaptureResult | null>(
      (resolve) => {
        this.pendingRegionCaptureResolve = resolve
      },
    )

    return this.pendingRegionCapturePromise
  }

  async finalizeRegionCapture(selection: RegionSelection) {
    if (!this.pendingRegionCaptureResolve) {
      this.resetRegionCapture()
      return
    }

    const resolve = this.pendingRegionCaptureResolve
    const result = await this.prepareRegionSelection(selection)
    resolve(result)
    this.resetRegionCapture()
  }

  async prepareRegionSelection(
    selection: RegionSelection,
  ): Promise<RegionCaptureResult> {
    let screenshot: ScreenshotCapture | null = null

    try {
      screenshot = await this.withSuspendedRegionCapture(async () => {
        const regionBounds = this.options.overlay.getOverlayBounds()
        const globalX = (regionBounds?.x ?? 0) + selection.x
        const globalY = (regionBounds?.y ?? 0) + selection.y
        const centerX = globalX + selection.width / 2
        const centerY = globalY + selection.height / 2
        const display = screen.getDisplayNearestPoint({
          x: centerX,
          y: centerY,
        })

        return this.captureRegionScreenshot(display, {
          x: globalX - display.bounds.x,
          y: globalY - display.bounds.y,
          width: selection.width,
          height: selection.height,
        })
      })
    } catch (error) {
      console.debug(
        '[capture] region capture failed:',
        (error as Error).message,
      )
    }

    return { screenshot, window: null }
  }

  commitPreparedRegionCapture(result: RegionCaptureResult | null) {
    if (!this.pendingRegionCaptureResolve) {
      this.resetRegionCapture()
      return
    }
    this.pendingRegionCaptureResolve(result)
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
    const {
      scaleFactor,
      x: screenX,
      y: screenY,
    } = this.toNativeScreenPoint({ x: dipX, y: dipY })

    const capture = await captureWindowScreenshot(screenX, screenY, {
      excludePids: [process.pid],
      excludeTitlePrefixes: STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES,
    })
    if (!capture) return null

    const { bounds } = capture.windowInfo
    const result = {
      screenshot: capture.screenshot,
      window: toChatContextWindow(capture.windowInfo),
    }
    return {
      bounds: {
        x: Math.round(bounds.x / scaleFactor) - regionBounds.x,
        y: Math.round(bounds.y / scaleFactor) - regionBounds.y,
        width: Math.round(bounds.width / scaleFactor),
        height: Math.round(bounds.height / scaleFactor),
      },
      thumbnail: capture.screenshot.dataUrl,
      result,
    }
  }

  async handleRegionClick(point: { x: number; y: number }) {
    if (!this.pendingRegionCaptureResolve) {
      this.resetRegionCapture()
      return
    }

    const resolve = this.pendingRegionCaptureResolve
    const regionBounds = this.options.overlay.getOverlayBounds()
    let capture: Awaited<ReturnType<typeof captureWindowScreenshot>> = null

    try {
      capture = await this.withCaptureContext(async () => {
        const capturePoint = this.toScreenPoint(point)
        return captureWindowScreenshot(capturePoint.x, capturePoint.y, {
          excludePids: [process.pid],
          excludeTitlePrefixes: STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES,
        })
      })
    } catch (error) {
      console.debug(
        '[capture] window capture at point failed:',
        (error as Error).message,
      )
    }

    // Native window capture failed (missing/broken helper, PrintWindow
    // refusal). Fall back to a desktopCapturer shot of the display under the
    // click so the user still gets an attachment instead of a silent no-op.
    let fallbackScreenshot: ScreenshotCapture | null = null
    if (!capture?.screenshot) {
      const dipPoint = {
        x: (regionBounds?.x ?? 0) + point.x,
        y: (regionBounds?.y ?? 0) + point.y,
      }
      const display = screen.getDisplayNearestPoint(dipPoint)
      fallbackScreenshot = await this.captureDisplayScreenshot(display)
    }

    resolve({
      screenshot: capture?.screenshot ?? fallbackScreenshot,
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
        {
          excludePids: [process.pid],
          excludeTitlePrefixes: STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES,
        },
      )
      if (windowCapture?.screenshot) {
        return windowCapture.screenshot
      }
      return this.captureDisplayScreenshot(display)
    })
  }

  async captureVisionScreenshots(point?: { x: number; y: number }) {
    const focusPoint = point ?? screen.getCursorScreenPoint()
    const primaryDisplay = screen.getDisplayNearestPoint(focusPoint)
    const displays = screen
      .getAllDisplays()
      .sort(
        (a, b) =>
          Number(b.id === primaryDisplay.id) -
          Number(a.id === primaryDisplay.id),
      )

    return this.withCaptureContext(async () => {
      const captures: VisionDisplayCapture[] = []

      for (const [index, display] of displays.entries()) {
        const displaySource = await this.getDisplaySource(display)
        if (!displaySource) {
          continue
        }

        const isPrimaryFocus = display.id === primaryDisplay.id
        const displayCount = displays.length
        const label =
          displayCount === 1
            ? 'screen 1 of 1 - primary focus'
            : isPrimaryFocus
              ? `screen ${index + 1} of ${displayCount} - primary focus (cursor is on this screen)`
              : `screen ${index + 1} of ${displayCount} - secondary screen`

        captures.push({
          ...this.buildVisionScreenshotFromImage(
            displaySource.source.thumbnail,
            display.bounds,
          ),
          displayId: Number(display.id),
          screenNumber: index + 1,
          label,
          isPrimaryFocus,
        })
      }

      return captures
    })
  }
}
