import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
  listNativeConnectors,
} from "../../../runtime/kernel/connectors/native-integrations.js";
import {
  getNativeOAuthProviderConfig,
  hasNativeOAuthProviderClientIdOverride,
  isNativeOAuthProviderConfigReady,
} from "../../../runtime/kernel/connectors/native-oauth-provider-config.js";
import { loadConnectorAccessToken } from "../../../runtime/kernel/connectors/oauth.js";
import { loadConfig } from "../../../runtime/kernel/google-workspace/config.js";
import { SCOPES as GOOGLE_WORKSPACE_SCOPES } from "../../../runtime/kernel/google-workspace/scopes.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

type NativeIntegrationHandlersOptions = {
  getStellaRoot: () => string | null;
  requestPreregisteredOAuth?: (payload: {
    tokenKey: string;
    displayName: string;
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint?: string;
    responseType?: "code" | "token";
    scopes?: string[];
    resourceUrl?: string;
    oauthResource?: string | null;
    callbackUrl?: string;
    callbackId?: string;
    callbackMode?: "local" | "external";
    scopeSeparator?: string;
    usesPkce?: boolean;
    authorizationRedirectParam?: string;
    authorizationParams?: Record<string, string>;
    tokenRedirectParam?: string;
    tokenAuth?: "body" | "basic";
    tokenExchange?: {
      type: "backend";
      provider: string;
    };
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  requestDeviceOAuth?: (payload: {
    tokenKey: string;
    displayName: string;
    clientId: string;
    deviceAuthorizationEndpoint: string;
    tokenEndpoint: string;
    scopes?: string[];
    resourceUrl?: string;
    verificationUri?: string;
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  disconnectGoogleWorkspace?: () => Promise<{ ok: boolean }>;
  getConvexAuthToken?: () => Promise<string | null>;
  getConvexSiteUrl?: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type BackendOAuthProvidersResponse = {
  providers?: Array<{
    id?: unknown;
    clientId?: unknown;
    externalCallbackReady?: unknown;
  }>;
};

type ConfiguredOAuthProviderSets = {
  backend: ReadonlySet<string>;
  externalCallback: ReadonlySet<string>;
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

const emptyConfiguredOAuthProviders = (): ConfiguredOAuthProviderSets => ({
  backend: new Set(),
  externalCallback: new Set(),
});

const loadConfiguredOAuthProviders = async (
  options: NativeIntegrationHandlersOptions,
) => {
  const siteUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
  if (!siteUrl) return emptyConfiguredOAuthProviders();
  const authToken = await options.getConvexAuthToken?.();
  if (!authToken) return emptyConfiguredOAuthProviders();
  const response = await fetch(`${siteUrl}/api/native-oauth/providers`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
    },
  }).catch(() => null);
  if (!response?.ok) return emptyConfiguredOAuthProviders();
  const payload = (await response
    .json()
    .catch(() => null)) as BackendOAuthProvidersResponse | null;
  const backend = new Set<string>();
  const externalCallback = new Set<string>();
  for (const provider of payload?.providers ?? []) {
    const id =
      typeof provider.id === "string" ? provider.id.trim().toLowerCase() : "";
    if (!id) continue;
    backend.add(id);
    // The hosted stella.sh OAuth callback route is provider-generic. Once a
    // provider has a server-side token exchange configured, an external
    // callback config can use the same bridge without another desktop code
    // change.
    if (provider.externalCallbackReady !== false) externalCallback.add(id);
  }
  return { backend, externalCallback };
};

const ensureNativeCredential = async (
  options: NativeIntegrationHandlersOptions,
  stellaRoot: string,
  id: string,
) => {
  const configuredOAuthProviders = await loadConfiguredOAuthProviders(options);
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
      throw new Error(
        `Could not connect Google Workspace: ${connected.reason}`,
      );
    }
    return;
  }

  if (entry?.provider === "oauth-catalog") {
    const config = getNativeOAuthProviderConfig(id);
    if (!config) {
      throw new Error(
        `${entry.name} supports OAuth, but Stella's provider setup is not ready yet.`,
      );
    }
    if (
      !isNativeOAuthProviderConfigReady(id, config, {
        configuredBackendProviders: configuredOAuthProviders.backend,
        configuredExternalCallbackProviders:
          configuredOAuthProviders.externalCallback,
      })
    ) {
      if (config.tokenExchange?.type === "backend") {
        const tokenExchangeProvider = (config.tokenExchange.provider ?? id)
          .trim()
          .toLowerCase();
        const hasExplicitOAuthApp =
          hasNativeOAuthProviderClientIdOverride(id) ||
          hasNativeOAuthProviderClientIdOverride(tokenExchangeProvider);
        if (!hasExplicitOAuthApp) {
          throw new Error(
            `${entry.name} supports OAuth, but Stella's provider setup is not ready yet.`,
          );
        }
        throw new Error(
          `${entry.name} supports OAuth, but Stella's secure server connection is not ready yet.`,
        );
      }
      if (
        config.flow === "authorization_code" &&
        config.callbackMode === "external"
      ) {
        throw new Error(
          `${entry.name} supports OAuth, but Stella's browser return link is not ready yet.`,
        );
      }
      throw new Error(
        `${entry.name} supports OAuth, but Stella's provider setup is not ready yet.`,
      );
    }
    if (await loadConnectorAccessToken(stellaRoot, config.tokenKey)) return;
    const connected =
      config.flow === "device"
        ? await options.requestDeviceOAuth?.({
            tokenKey: config.tokenKey,
            displayName: entry.name,
            clientId: config.clientId,
            deviceAuthorizationEndpoint: config.deviceAuthorizationEndpoint,
            tokenEndpoint: config.tokenEndpoint!,
            scopes: config.scopes,
            resourceUrl: config.resourceUrl,
            verificationUri: config.verificationUri,
            description: `Stella needs to open ${entry.name} in your browser. Enter the code shown here to approve access.`,
          })
        : await options.requestPreregisteredOAuth?.({
            tokenKey: config.tokenKey,
            displayName: entry.name,
            clientId: config.clientId,
            authorizationEndpoint: config.authorizationEndpoint,
            tokenEndpoint: config.tokenEndpoint,
            responseType: config.responseType,
            scopes: config.scopes,
            resourceUrl: config.resourceUrl,
            oauthResource: config.oauthResource,
            callbackUrl: config.callbackUrl,
            callbackId: config.callbackId,
            callbackMode: config.callbackMode,
            scopeSeparator: config.scopeSeparator,
            usesPkce: config.usesPkce,
            authorizationRedirectParam: config.authorizationRedirectParam,
            authorizationParams: config.authorizationParams,
            tokenRedirectParam: config.tokenRedirectParam,
            tokenAuth: config.tokenAuth,
            tokenExchange:
              config.tokenExchange?.type === "backend"
                ? {
                    type: "backend",
                    provider: config.tokenExchange.provider ?? id,
                  }
                : undefined,
            description: `Stella needs to open ${entry.name} in your browser so you can sign in and approve access.`,
          });
    if (!connected) {
      throw new Error(`${entry.name} connection is unavailable.`);
    }
    if (!connected.ok) {
      throw new Error(`Could not connect ${entry.name}: ${connected.reason}`);
    }
    return;
  }

  throw new Error(
    `${entry?.name ?? id} is not available as an OAuth Store integration yet.`,
  );
};

export const registerNativeIntegrationHandlers = (
  options: NativeIntegrationHandlersOptions,
) => {
  ipcMain.handle("nativeIntegrations:list", async (event) => {
    assertPrivilegedRequest(options, event, "nativeIntegrations:list");
    const configuredOAuthProviders =
      await loadConfiguredOAuthProviders(options);
    return await listNativeConnectors(requireRoot(options), {
      configuredBackendProviders: configuredOAuthProviders.backend,
      configuredExternalCallbackProviders:
        configuredOAuthProviders.externalCallback,
    });
  });

  ipcMain.handle(
    "nativeIntegrations:enable",
    async (event, payload: unknown) => {
      assertPrivilegedRequest(options, event, "nativeIntegrations:enable");
      const stellaRoot = requireRoot(options);
      const id = readId(payload);
      await ensureNativeCredential(options, stellaRoot, id);
      const configuredOAuthProviders =
        await loadConfiguredOAuthProviders(options);
      return await enableNativeConnector(stellaRoot, id, "store", {
        configuredBackendProviders: configuredOAuthProviders.backend,
        configuredExternalCallbackProviders:
          configuredOAuthProviders.externalCallback,
      });
    },
  );

  ipcMain.handle(
    "nativeIntegrations:disable",
    async (event, payload: unknown) => {
      assertPrivilegedRequest(options, event, "nativeIntegrations:disable");
      const stellaRoot = requireRoot(options);
      const id = readId(payload);
      const configuredOAuthProviders =
        await loadConfiguredOAuthProviders(options);
      const result = await disableNativeConnector(stellaRoot, id, {
        configuredBackendProviders: configuredOAuthProviders.backend,
        configuredExternalCallbackProviders:
          configuredOAuthProviders.externalCallback,
      });
      const entry = getNativeConnectorCatalogEntry(id);
      if (
        entry?.provider === "google-workspace" &&
        options.disconnectGoogleWorkspace
      ) {
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
    },
  );
};
