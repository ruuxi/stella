import type { WindowInfo } from "./window-capture.js";
import type { ChatContext } from "../../runtime/contracts/index.js";
import type {
  UiMode,
  UiState,
} from "../src/shared/contracts/ui.js";

export type { UiMode, UiState };

export type ScreenshotCapture = {
  dataUrl: string;
  width: number;
  height: number;
};

export type VisionCoordinateSpace = {
  x: number;
  y: number;
  logicalWidth: number;
  logicalHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
};

export type VisionScreenshotCapture = ScreenshotCapture & {
  coordinateSpace: VisionCoordinateSpace;
};

export type VisionDisplayCapture = VisionScreenshotCapture & {
  displayId: number;
  screenNumber: number;
  label: string;
  isPrimaryFocus: boolean;
};

export type RegionSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RegionCaptureResult = {
  screenshot: ScreenshotCapture | null;
  window: ChatContext["window"];
};

export type CredentialRequestPayload = {
  requestId: string;
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
};

export type CredentialResponsePayload = {
  requestId: string;
  secretId: string;
  provider: string;
  label: string;
};

/**
 * Inline in-chat connect card (agent-initiated via
 * `stella-connect request-connection`). The renderer shows the card in
 * the active chat surface; accept runs the same enable + OAuth flow as
 * the Store, decline resolves back to the CLI which persists a
 * "don't re-offer" preference.
 */
export type ConnectorConnectRequestPayload = {
  requestId: string;
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  /** One-line agent-provided context, e.g. "To check your recent purchases". */
  reason?: string;
  /**
   * What the card connects. "integration" (default) runs the Store
   * enable + OAuth flow; "browser-extension" opens the Chrome Web Store
   * for the Stella Browser Bridge extension and waits for the install.
   */
  kind?: "integration" | "browser-extension";
  /**
   * Chat the card belongs to. Renderer surfaces show the card only in
   * the matching conversation; unscoped requests (legacy CLI path) show
   * everywhere.
   */
  conversationId?: string;
};

export type ConnectorConnectPhase =
  | "connecting"
  | "connected"
  | "declined"
  | "cancelled"
  | "timeout"
  | "error";

export type ConnectorConnectUpdatePayload = {
  requestId: string;
  phase: ConnectorConnectPhase;
  message?: string;
};

export type ConnectorConnectRespondPayload = {
  requestId: string;
  action: "accept" | "decline" | "cancel";
};

export const toChatContextWindow = (
  windowInfo: WindowInfo | null | undefined,
): ChatContext["window"] => {
  if (!windowInfo || (!windowInfo.title && !windowInfo.process)) {
    return null;
  }
  return {
    title: windowInfo.title,
    app: windowInfo.process,
    bounds: windowInfo.bounds,
  };
};
