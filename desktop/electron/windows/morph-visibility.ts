import { screen, type BrowserWindow } from 'electron'
import {
  getWindowInfoAtPoint,
  getWindowInfoBatchAtPoints,
  type WindowInfo,
} from '../window-capture.js'

type Bounds = { x: number; y: number; width: number; height: number }

type MorphVisibilityWindow = Pick<
  BrowserWindow,
  'getBounds' | 'isDestroyed' | 'isFocused' | 'isMinimized' | 'isVisible'
>

type QueryWindowInfo = (
  x: number,
  y: number,
) => Promise<WindowInfo | null>

type QueryWindowInfoBatch = (
  points: Array<{ x: number; y: number }>,
) => Promise<(WindowInfo | null)[] | null>

export type MorphVisibilityDecision = {
  showMorph: boolean
  reason:
    | 'focused'
    | 'hidden'
    | 'minimized'
    | 'destroyed'
    | 'invalid-bounds'
    | 'unsupported-platform'
    | 'visible-enough'
    | 'mostly-covered'
    | 'probe-failed'
  visibleRatio?: number
  visibleSamples?: number
  totalSamples?: number
}

type MorphVisibilityOptions = {
  currentPid?: number
  platform?: NodeJS.Platform
  queryWindowInfo?: QueryWindowInfo
  queryWindowInfoBatch?: QueryWindowInfoBatch
  visibleRatioThreshold?: number
}

const DEFAULT_VISIBLE_RATIO_THRESHOLD = 0.5
const SAMPLE_COLUMNS = 4
const SAMPLE_ROWS = 3

const area = (bounds: Bounds) =>
  Math.max(0, bounds.width) * Math.max(0, bounds.height)

const intersectArea = (a: Bounds, b: Bounds) => {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

const getDisplayScaleFactor = (display: Electron.Display) =>
  process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)

const toNativePoint = (point: { x: number; y: number }) => {
  const display = screen.getDisplayNearestPoint(point)
  const scaleFactor = getDisplayScaleFactor(display)
  return {
    x: Math.round(point.x * scaleFactor),
    y: Math.round(point.y * scaleFactor),
  }
}

const toNativeBounds = (bounds: Bounds): Bounds => {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
  const display = screen.getDisplayNearestPoint(center)
  const scaleFactor = getDisplayScaleFactor(display)
  return {
    x: Math.round(bounds.x * scaleFactor),
    y: Math.round(bounds.y * scaleFactor),
    width: Math.round(bounds.width * scaleFactor),
    height: Math.round(bounds.height * scaleFactor),
  }
}

export const isLikelySameWindowBounds = (
  targetBounds: Bounds,
  candidateBounds: Bounds,
) => {
  const targetArea = area(targetBounds)
  const candidateArea = area(candidateBounds)
  if (targetArea <= 0 || candidateArea <= 0) return false

  const overlap = intersectArea(targetBounds, candidateBounds)
  const targetCoverage = overlap / targetArea
  const candidateCoverage = overlap / candidateArea

  return targetCoverage >= 0.75 && candidateCoverage >= 0.6
}

export const createMorphVisibilitySamplePoints = (bounds: Bounds) => {
  const insetX = Math.min(24, Math.max(4, bounds.width * 0.06))
  const insetY = Math.min(24, Math.max(4, bounds.height * 0.06))
  const left = bounds.x + Math.min(insetX, bounds.width / 3)
  const right = bounds.x + bounds.width - Math.min(insetX, bounds.width / 3)
  const top = bounds.y + Math.min(insetY, bounds.height / 3)
  const bottom = bounds.y + bounds.height - Math.min(insetY, bounds.height / 3)
  const points: Array<{ x: number; y: number }> = []

  for (let row = 0; row < SAMPLE_ROWS; row += 1) {
    const rowT = row / (SAMPLE_ROWS - 1)
    for (let col = 0; col < SAMPLE_COLUMNS; col += 1) {
      const colT = col / (SAMPLE_COLUMNS - 1)
      points.push({
        x: left + (right - left) * colT,
        y: top + (bottom - top) * rowT,
      })
    }
  }

  return points
}

export async function shouldShowMorphForWindow(
  targetWindow: MorphVisibilityWindow,
  options?: MorphVisibilityOptions,
): Promise<MorphVisibilityDecision> {
  if (targetWindow.isDestroyed()) {
    return { showMorph: false, reason: 'destroyed' }
  }
  if (!targetWindow.isVisible()) {
    return { showMorph: false, reason: 'hidden' }
  }
  if (targetWindow.isMinimized()) {
    return { showMorph: false, reason: 'minimized' }
  }
  if (targetWindow.isFocused()) {
    return { showMorph: true, reason: 'focused' }
  }

  const platform = options?.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    return { showMorph: true, reason: 'unsupported-platform' }
  }

  const bounds = targetWindow.getBounds()
  if (bounds.width <= 0 || bounds.height <= 0) {
    return { showMorph: false, reason: 'invalid-bounds' }
  }

  const currentPid = options?.currentPid ?? process.pid
  const targetNativeBounds = toNativeBounds(bounds)
  const points = createMorphVisibilitySamplePoints(bounds)
  const nativePoints = points.map(toNativePoint)

  // Resolve every sample point's topmost window. The default path issues a
  // single batched native-helper call (one process spawn for all points);
  // when the helper can't answer the batch (old binary, failure) we fall back
  // to per-point queries. An explicitly-injected `queryWindowInfo` (tests /
  // callers) always takes the per-point path so behavior stays deterministic.
  let infos: (WindowInfo | null)[]
  if (options?.queryWindowInfo) {
    infos = await Promise.all(
      nativePoints.map((point) =>
        options.queryWindowInfo!(point.x, point.y),
      ),
    )
  } else {
    const batchQuery = options?.queryWindowInfoBatch ?? getWindowInfoBatchAtPoints
    const batchInfos = await batchQuery(nativePoints)
    if (batchInfos) {
      infos = batchInfos
    } else if (platform === 'win32') {
      // The native helper couldn't answer the occlusion probe (missing/old
      // binary or a transient failure). The window already passed the
      // destroyed / hidden / minimized checks above, so the only thing we
      // can't confirm is whether another app is covering it. Suppressing the
      // morph here meant Windows users never saw the transition at all
      // whenever the helper was unavailable (the "glim" animation looked
      // broken). Prefer showing it — a brief overlay over a covered window is
      // a far smaller papercut than the animation silently never playing.
      return { showMorph: true, reason: 'probe-failed' }
    } else {
      infos = await Promise.all(
        nativePoints.map((point) =>
          getWindowInfoAtPoint(point.x, point.y),
        ),
      )
    }
  }

  const results = infos.map((info) =>
    Boolean(
      info &&
        info.pid === currentPid &&
        isLikelySameWindowBounds(targetNativeBounds, info.bounds),
    ),
  )
  const visibleSamples = results.filter(Boolean).length
  const visibleRatio = points.length > 0 ? visibleSamples / points.length : 0
  const threshold =
    options?.visibleRatioThreshold ?? DEFAULT_VISIBLE_RATIO_THRESHOLD

  if (visibleRatio >= threshold) {
    return {
      showMorph: true,
      reason: 'visible-enough',
      visibleRatio,
      visibleSamples,
      totalSamples: points.length,
    }
  }

  return {
    showMorph: false,
    reason: 'mostly-covered',
    visibleRatio,
    visibleSamples,
    totalSamples: points.length,
  }
}
