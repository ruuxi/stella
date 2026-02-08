import type { JSX } from 'react'
import type { CanvasPayload } from '@/app/state/canvas-state'

type CanvasRenderer = (props: { canvas: CanvasPayload }) => JSX.Element | null

export const canvasRegistry = new Map<string, CanvasRenderer>()

/** Register a canvas component for a given key */
export const registerCanvas = (key: string, renderer: CanvasRenderer) => {
  canvasRegistry.set(key, renderer)
}
