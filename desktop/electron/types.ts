import type { WindowInfo } from "./window-capture.js";
import type { ChatContext } from "../../runtime/contracts/index.js";
import type {
  UiMode,
  WindowMode,
  UiState,
} from "../src/shared/contracts/ui.js";

export type { UiMode, WindowMode, UiState };

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
 * Connector credential dialog (Stella Connect / MCP). Distinct from
 * `CredentialRequestPayload` because the value is written directly to
 * `~/.stella/connectors/.credentials.json` via `saveConnectorAccessToken` on
 * the host — it never travels back over IPC, never reaches the model
 * context, and never enters Convex's `secrets` table. The CLI bridge
 * spawns these when `stella-connect call` returns 401/403.
 *
 * `mode: "oauth"` switches the renderer to the same connect dialog shell
 * with an explicit "Open browser" approval. The host opens the user's
 * external browser only after submit. For bridge-owned OAuth requests it
 * then runs a local 127.0.0.1 callback listener and persists the token.
 *
 * `mode: "api_key"` (default) keeps the paste-key modal.
 */
export type ConnectorCredentialRequestMode = "api_key" | "oauth";

export type ConnectorCredentialRequestPayload = {
  requestId: string;
  tokenKey: string;
  displayName: string;
  mode: ConnectorCredentialRequestMode;
  completionMode?: "approve" | "wait";
  description?: string;
  placeholder?: string;
  oauthUserCode?: string;
  oauthVerificationUri?: string;
};

export type ConnectorCredentialSubmitPayload = {
  requestId: string;
  value: string;
  label?: string;
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
