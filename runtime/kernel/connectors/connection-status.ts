/**
 * Shared connection-state lookup for native Store integrations.
 *
 * One place answers "is this integration usable right now?" for the CLI
 * (`stella-connect installed/apps/discover`), the connector keyword
 * reminder, and the orchestrator's `connector_status` tool.
 */

import {
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
