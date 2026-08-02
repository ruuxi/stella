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
export type NativeConnectorAuthStatus =
  | "connected"
  | "not_connected"
  | "unverified";

/**
 * Credential-side status only (does a usable token/account exist?). Backend
 * Composio accounts are never inferred from local enablement: callers must
 * supply the result of the authenticated backend status probe.
 */
export const nativeConnectorAuthStatus = async (
  _stellaDataDir: string,
  _entry: NativeConnectorCatalogEntry,
  accountConnected?: boolean,
): Promise<NativeConnectorAuthStatus> => {
  return accountConnected === true
    ? "connected"
    : accountConnected === false
      ? "not_connected"
      : "unverified";
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
  options: { accountConnected?: boolean } = {},
): Promise<NativeConnectorConnectionState> => {
  const [enabled, authStatus] = await Promise.all([
    isNativeConnectorEnabled(stellaDataDir, entry.id),
    nativeConnectorAuthStatus(stellaDataDir, entry, options.accountConnected),
  ]);
  return {
    enabled,
    authStatus,
    connected: enabled && authStatus === "connected",
    accountVerified: authStatus === "connected",
  };
};

/**
 * Provider-aware operational readiness shared by status and CLI consumers.
 * An integration is executable only after both local enablement and a verified
 * backend account connection.
 */
export const getNativeConnectorReadiness = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
  options: { accountConnected?: boolean } = {},
): Promise<NativeConnectorReadiness> => {
  const state = await getNativeConnectorConnectionState(
    stellaDataDir,
    entry,
    options,
  );
  const toolCount = getNativeConnectorTools(entry).length;
  return {
    ...state,
    toolCount,
    executable: state.connected && toolCount > 0,
  };
};
