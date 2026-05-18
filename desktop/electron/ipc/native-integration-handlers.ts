import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
  listNativeConnectors,
} from "../../../runtime/kernel/connectors/native-integrations.js";
import { getNativeProviderManifest } from "../../../runtime/kernel/connectors/native-provider-actions.js";
import { loadConnectorAccessToken } from "../../../runtime/kernel/connectors/oauth.js";
import { loadConfig } from "../../../runtime/kernel/google-workspace/config.js";
import { SCOPES as GOOGLE_WORKSPACE_SCOPES } from "../../../runtime/kernel/google-workspace/scopes.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

type NativeIntegrationHandlersOptions = {
  getStellaRoot: () => string | null;
  requestConnectorCredential?: (payload: {
    tokenKey: string;
    displayName: string;
    authType?: "api_key" | "oauth";
    description?: string;
    placeholder?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  requestPreregisteredOAuth?: (payload: {
    tokenKey: string;
    displayName: string;
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    scopes?: string[];
    resourceUrl?: string;
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  disconnectGoogleWorkspace?: () => Promise<{ ok: boolean }>;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const readId = (payload: unknown) => {
  const id =
    payload && typeof payload === "object"
      ? (payload as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Missing integration id.");
  }
  return id.trim();
};

const requireRoot = (options: NativeIntegrationHandlersOptions) => {
  const stellaRoot = options.getStellaRoot();
  if (!stellaRoot) throw new Error("Stella root is unavailable.");
  return stellaRoot;
};

const ensureNativeCredential = async (
  options: NativeIntegrationHandlersOptions,
  stellaRoot: string,
  id: string,
) => {
  const entry = getNativeConnectorCatalogEntry(id);
  if (entry?.provider === "google-workspace") {
    if (await loadConnectorAccessToken(stellaRoot, "google-workspace")) return;
    if (!options.requestPreregisteredOAuth) {
      throw new Error("Google Workspace connection is unavailable.");
    }
    const config = loadConfig();
    const connected = await options.requestPreregisteredOAuth({
      tokenKey: "google-workspace",
      displayName: "Google Workspace",
      clientId: config.clientId,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes: GOOGLE_WORKSPACE_SCOPES,
      description:
        "Stella needs to open Google in your browser so you can sign in and approve Workspace access.",
    });
    if (!connected.ok) {
      throw new Error(`Could not connect Google Workspace: ${connected.reason}`);
    }
    return;
  }

  const manifest = getNativeProviderManifest(id);
  if (!manifest) return;
  if (await loadConnectorAccessToken(stellaRoot, manifest.auth.tokenKey)) return;
  if (!options.requestConnectorCredential) {
    throw new Error("Credential prompt is unavailable.");
  }
  const result = await options.requestConnectorCredential({
    tokenKey: manifest.auth.tokenKey,
    displayName: entry?.name ?? id,
    authType: manifest.auth.type,
    description: manifest.auth.description,
    placeholder: manifest.auth.placeholder,
  });
  if (!result.ok) {
    throw new Error(`Could not connect ${entry?.name ?? id}: ${result.reason}`);
  }
};

export const registerNativeIntegrationHandlers = (
  options: NativeIntegrationHandlersOptions,
) => {
  ipcMain.handle("nativeIntegrations:list", async (event) => {
    assertPrivilegedRequest(options, event, "nativeIntegrations:list");
    return await listNativeConnectors(requireRoot(options));
  });

  ipcMain.handle("nativeIntegrations:enable", async (event, payload: unknown) => {
    assertPrivilegedRequest(options, event, "nativeIntegrations:enable");
    const stellaRoot = requireRoot(options);
    const id = readId(payload);
    await ensureNativeCredential(options, stellaRoot, id);
    return await enableNativeConnector(stellaRoot, id, "store");
  });

  ipcMain.handle("nativeIntegrations:disable", async (event, payload: unknown) => {
    assertPrivilegedRequest(options, event, "nativeIntegrations:disable");
    const stellaRoot = requireRoot(options);
    const id = readId(payload);
    const result = await disableNativeConnector(stellaRoot, id);
    const entry = getNativeConnectorCatalogEntry(id);
    if (entry?.provider === "google-workspace" && options.disconnectGoogleWorkspace) {
      const remaining = await listNativeConnectors(stellaRoot);
      const stillEnabledGoogle = remaining.some(
        (connector) =>
          connector.provider === "google-workspace" && connector.enabled,
      );
      if (!stillEnabledGoogle) {
        await options.disconnectGoogleWorkspace();
      }
    }
    return result;
  });
};
