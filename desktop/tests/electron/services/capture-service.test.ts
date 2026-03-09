import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureOverlayBridge, CaptureWindowBridge } from '../../../electron/services/capture-service.js'

const registerShortcut = vi.fn()
const unregisterShortcut = vi.fn()
const getDisplayNearestPoint = vi.fn(() => ({
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
}))
const captureWindowScreenshot = vi.fn()

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
  globalShortcut: {
    register: registerShortcut,
    unregister: unregisterShortcut,
  },
  screen: {
    getDisplayNearestPoint,
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
  },
}))

vi.mock('../../../electron/window-capture.js', () => ({
  captureWindowScreenshot,
  getWindowInfoAtPoint: vi.fn(),
}))

const { CaptureService } = await import('../../../electron/services/capture-service.js')

const createWindowBridge = (): CaptureWindowBridge => ({
  getAllWindows: () => [],
  getMiniWindow: () => null,
  isMiniShowing: () => false,
  showWindow: () => {},
  concealMiniWindowForCapture: () => false,
  restoreMiniWindowAfterCapture: () => {},
})

const createOverlayBridge = (): CaptureOverlayBridge => ({
  hideRadial: vi.fn(),
  hideModifierBlock: vi.fn(),
  startRegionCapture: vi.fn(),
  endRegionCapture: vi.fn(),
  getOverlayBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
})

describe('CaptureService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    registerShortcut.mockReset()
    unregisterShortcut.mockReset()
    getDisplayNearestPoint.mockClear()
    captureWindowScreenshot.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('unregisters Escape after click-to-window region capture completes', async () => {
    captureWindowScreenshot.mockResolvedValue({
      screenshot: {
        dataUrl: 'data:image/png;base64,abc',
        width: 320,
        height: 200,
      },
      windowInfo: {
        title: 'Notes',
        process: 'Notes',
        pid: 42,
        bounds: { x: 10, y: 20, width: 320, height: 200 },
      },
    })

    const overlay = createOverlayBridge()
    const service = new CaptureService({
      window: createWindowBridge(),
      overlay,
      updateUiState: () => {},
    })

    const pendingCapture = service.startRegionCapture()
    const clickPromise = service.handleRegionClick({ x: 120, y: 80 })

    await vi.runAllTimersAsync()
    await clickPromise

    await expect(pendingCapture).resolves.toEqual({
      screenshot: {
        dataUrl: 'data:image/png;base64,abc',
        width: 320,
        height: 200,
      },
      window: {
        title: 'Notes',
        app: 'Notes',
        bounds: { x: 10, y: 20, width: 320, height: 200 },
      },
    })

    expect(registerShortcut).toHaveBeenCalledWith('Escape', expect.any(Function))
    expect(unregisterShortcut).toHaveBeenCalledWith('Escape')
    expect(overlay.endRegionCapture).toHaveBeenCalled()
  })
})
