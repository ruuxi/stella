import type { WindowInfo } from './window-capture.js'
import type { ChatContext } from '../../runtime/contracts/index.js'
import type {
  UiMode,
  WindowMode,
  UiState,
} from '../src/shared/contracts/ui.js'

export type { UiMode, WindowMode, UiState }

export type ScreenshotCapture = {
  dataUrl: string
  width: number
  height: number
}

export type VisionCoordinateSpace = {
  x: number
  y: number
  logicalWidth: number
  logicalHeight: number
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
}

export type VisionScreenshotCapture = ScreenshotCapture & {
  coordinateSpace: VisionCoordinateSpace
}

export type VisionDisplayCapture = VisionScreenshotCapture & {
  displayId: number
  screenNumber: number
  label: string
  isPrimaryFocus: boolean
}

export type RegionSelection = {
  x: number
  y: number
  width: number
  height: number
}

export type RegionCaptureResult = {
  screenshot: ScreenshotCapture | null
  window: ChatContext['window']
}

export type CredentialRequestPayload = {
  requestId: string
  provider: string
  label?: string
  description?: string
  placeholder?: string
}

export type CredentialResponsePayload = {
  requestId: string
  secretId: string
  provider: string
  label: string
}

/**
 * Connector credential dialog (Stella Connect / MCP). Distinct from
 * `CredentialRequestPayload` because the value is written directly to
 * `state/connectors/.credentials.json` via `saveConnectorAccessToken` on
 * the host — it never travels back over IPC, never reaches the model
 * context, and never enters Convex's `secrets` table. The CLI bridge
 * spawns these when `stella-connect call` returns 401/403.
 *
 * `mode: "oauth"` switches the renderer to a no-input indicator dialog
 * ("Connecting <X>... Authorize in the browser tab Stella opened.") with
 * only a Cancel affordance. The host opens the user's external browser
 * via `shell.openExternal`, runs a local 127.0.0.1 callback listener,
 * and persists the resulting access_token directly — `submit` never
 * fires from the renderer in this mode.
 *
 * `mode: "api_key"` (default) keeps the paste-key modal.
 */
export type ConnectorCredentialRequestMode = "api_key" | "oauth"

export type ConnectorCredentialRequestPayload = {
  requestId: string
  tokenKey: string
  displayName: string
  mode: ConnectorCredentialRequestMode
  description?: string
  placeholder?: string
}

export type ConnectorCredentialSubmitPayload = {
  requestId: string
  value: string
  label?: string
}

export const toChatContextWindow = (
  windowInfo: WindowInfo | null | undefined,
): ChatContext['window'] => {
  if (!windowInfo || (!windowInfo.title && !windowInfo.process)) {
    return null
  }
  return {
    title: windowInfo.title,
    app: windowInfo.process,
    bounds: windowInfo.bounds,
  }
}
