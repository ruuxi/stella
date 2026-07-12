/**
 * Shared connection-state lookup for native Store integrations.
 *
 * One place answers "is this integration usable right now?" for the CLI
 * (`stella-connect installed/apps/discover`), the connector keyword
 * reminder, and the orchestrator's `connector_status` tool.
 */

import {
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  type NativeConnectorCatalogEntry,
} from "./native-integrations.js";
import { getNativeOAuthProviderConfig } from "./native-oauth-provider-config.js";
import { loadConnectorAccessToken } from "./oauth.js";

export type NativeConnectorAuthStatus =
  | "connected"
  | "backend_managed_unverified"
  | "not_logged_in"
  | "unsupported";

/**
 * Credential-side status only (does a usable token/account exist?).
 * `backend-composio` accounts live server-side behind the user's Stella
 * auth, so they are reported as connected — enablement is the local
 * gate for those.
 */
export const nativeConnectorAuthStatus = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorAuthStatus> => {
  if (entry.provider === "google-workspace") {
    return (await loadConnectorAccessToken(stellaDataDir, "google-workspace"))
      ? "connected"
      : "not_logged_in";
  }
  if (entry.provider === "backend-composio")
    return "backend_managed_unverified";
  const config = entry.oauthConfig ?? getNativeOAuthProviderConfig(entry.id);
  if (!config?.tokenKey) return "unsupported";
  return (await loadConnectorAccessToken(stellaDataDir, config.tokenKey))
    ? "connected"
    : "not_logged_in";
};

export type NativeConnectorConnectionState = {
  enabled: boolean;
  authStatus: NativeConnectorAuthStatus;
  /** Enabled AND credentialed — safe to call through stella-connect. */
  connected: boolean;
  /** True only when this process actually verified a provider credential. */
  accountVerified: boolean;
};

export type NativeConnectorReadiness = NativeConnectorConnectionState & {
  toolCount: number;
  /** The CLI has a dispatcher it can attempt with the current local state. */
  executable: boolean;
};

export const getNativeConnectorConnectionState = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorConnectionState> => {
  const [enabled, authStatus] = await Promise.all([
    isNativeConnectorEnabled(stellaDataDir, entry.id),
    nativeConnectorAuthStatus(stellaDataDir, entry),
  ]);
  return {
    enabled,
    authStatus,
    connected:
      enabled &&
      (authStatus === "connected" ||
        authStatus === "backend_managed_unverified"),
    accountVerified: authStatus === "connected",
  };
};

/**
 * Provider-aware operational readiness shared by status and CLI consumers.
 * Backend execution is intentionally actionable without claiming the remote
 * provider account was verified; the run endpoint remains the auth authority.
 */
export const getNativeConnectorReadiness = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorReadiness> => {
  const state = await getNativeConnectorConnectionState(stellaDataDir, entry);
  const toolCount = getNativeConnectorTools(entry).length;
  const credentialReady =
    state.authStatus === "connected" ||
    state.authStatus === "backend_managed_unverified";
  return {
    ...state,
    toolCount,
    executable: state.enabled && toolCount > 0 && credentialReady,
  };
};
