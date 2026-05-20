import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  buildNativeConnectorCatalog,
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
  getNativeConnectorOAuthConfig,
  listNativeConnectors,
  type NativeConnectorCatalogEntry,
} from "../../../runtime/kernel/connectors/native-integrations.js";
import {
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

type BackendNativeIntegrationsResponse = {
  integrations?: unknown[];
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

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

const readStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" && key.trim() && entry.trim()
      ? ([[key.trim(), entry.trim()]] as const)
      : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const toServerNativeConnectorEntry = (
  value: unknown,
): NativeConnectorCatalogEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const connector =
    record.connector && typeof record.connector === "object"
      ? (record.connector as Record<string, unknown>)
      : null;
  const oauth =
    connector?.oauth && typeof connector.oauth === "object"
      ? (connector.oauth as Record<string, unknown>)
      : null;
  const id = typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const category =
    typeof record.category === "string" ? record.category.trim() : "integrations";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  const clientId = typeof oauth?.clientId === "string" ? oauth.clientId.trim() : "";
  const authorizationEndpoint =
    typeof oauth?.authorizationEndpoint === "string"
      ? oauth.authorizationEndpoint.trim()
      : "";
  const tokenEndpoint =
    typeof oauth?.tokenEndpoint === "string" ? oauth.tokenEndpoint.trim() : "";
  if (!id || !name || !description || !clientId || !authorizationEndpoint) {
    return null;
  }
  const tokenExchangeProvider =
    typeof oauth?.tokenExchangeProvider === "string"
      ? oauth.tokenExchangeProvider.trim().toLowerCase()
      : id;
  const responseType = oauth?.responseType === "token" ? "token" : "code";
  if (responseType === "code" && !tokenEndpoint) return null;
  const scopes = readStringArray(oauth?.scopes);
  const authorizationParams = readStringRecord(oauth?.authorizationParams);
  return {
    id,
    name,
    category,
    auth: readStringArray(record.auth) ?? ["OAUTH2"],
    catalogToolCount:
      typeof record.catalogToolCount === "number" ? record.catalogToolCount : 0,
    availability: "ready",
    provider: "oauth-catalog",
    description,
    ...(typeof record.sourceUrl === "string" && record.sourceUrl.trim()
      ? { sourceUrl: record.sourceUrl.trim() }
      : {}),
    ...(typeof record.iconUrl === "string" && record.iconUrl.trim()
      ? { iconUrl: record.iconUrl.trim() }
      : {}),
    connectable: false,
    oauthConfig: {
      flow: "authorization_code",
      tokenKey:
        typeof oauth?.tokenKey === "string" && oauth.tokenKey.trim()
          ? oauth.tokenKey.trim()
          : `native-oauth:${id}`,
      clientId,
      authorizationEndpoint,
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      responseType,
      callbackId:
        typeof oauth?.callbackId === "string" && oauth.callbackId.trim()
          ? oauth.callbackId.trim()
          : id,
      callbackUrl:
        typeof oauth?.callbackUrl === "string" && oauth.callbackUrl.trim()
          ? oauth.callbackUrl.trim()
          : `https://stella.sh/oauth/${id}/callback`,
      callbackMode: oauth?.callbackMode === "local" ? "local" : "external",
      ...(scopes ? { scopes } : {}),
      ...(typeof oauth?.resourceUrl === "string" && oauth.resourceUrl.trim()
        ? { resourceUrl: oauth.resourceUrl.trim() }
        : {}),
      ...(typeof oauth?.oauthResource === "string"
        ? { oauthResource: oauth.oauthResource.trim() || null }
        : {}),
      ...(oauth?.usesPkce === true ? { usesPkce: true } : {}),
      ...(typeof oauth?.scopeSeparator === "string" && oauth.scopeSeparator
        ? { scopeSeparator: oauth.scopeSeparator }
        : {}),
      ...(typeof oauth?.authorizationRedirectParam === "string" &&
      oauth.authorizationRedirectParam.trim()
        ? { authorizationRedirectParam: oauth.authorizationRedirectParam.trim() }
        : {}),
      ...(authorizationParams ? { authorizationParams } : {}),
      ...(typeof oauth?.tokenRedirectParam === "string" &&
      oauth.tokenRedirectParam.trim()
        ? { tokenRedirectParam: oauth.tokenRedirectParam.trim() }
        : {}),
      ...(oauth?.tokenAuth === "basic" ? { tokenAuth: "basic" as const } : {}),
      tokenExchange: {
        type: "backend",
        provider: tokenExchangeProvider,
      },
    },
  };
};

const loadServerNativeConnectorCatalog = async (
  options: NativeIntegrationHandlersOptions,
) => {
  const siteUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
  if (!siteUrl) return null;
  const response = await fetch(`${siteUrl}/api/native-integrations/catalog`, {
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload = (await response
    .json()
    .catch(() => null)) as BackendNativeIntegrationsResponse | null;
  return (payload?.integrations ?? [])
    .map(toServerNativeConnectorEntry)
    .filter((entry): entry is NativeConnectorCatalogEntry => Boolean(entry));
};

const ensureNativeCredential = async (
  options: NativeIntegrationHandlersOptions,
  stellaRoot: string,
  id: string,
) => {
  const configuredOAuthProviders = await loadConfiguredOAuthProviders(options);
  const catalog = buildNativeConnectorCatalog(
    (await loadServerNativeConnectorCatalog(options)) ?? undefined,
  );
  const entry = getNativeConnectorCatalogEntry(id, catalog);
  if (entry?.provider === "google-workspace") {
    if (await loadConnectorAccessToken(stellaRoot, "google-workspace")) return;
    if (!options.requestPreregisteredOAuth) {
      throw new Error("Google Workspace connection is unavailable.");
    }
    const config = loadConfig();
    if (!configuredOAuthProviders.backend.has("google-workspace")) {
      throw new Error(
        "Google Workspace secure connection is not ready yet.",
      );
    }
    const connected = await options.requestPreregisteredOAuth({
      tokenKey: "google-workspace",
      displayName: "Google Workspace",
      clientId: config.clientId,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes: GOOGLE_WORKSPACE_SCOPES,
      tokenExchange: {
        type: "backend",
        provider: "google-workspace",
      },
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
    const config = getNativeConnectorOAuthConfig(entry);
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
    const serverCatalog = await loadServerNativeConnectorCatalog(options);
    return await listNativeConnectors(
      requireRoot(options),
      {
        configuredBackendProviders: configuredOAuthProviders.backend,
        configuredExternalCallbackProviders:
          configuredOAuthProviders.externalCallback,
      },
      serverCatalog ?? undefined,
    );
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
      const serverCatalog = await loadServerNativeConnectorCatalog(options);
      return await enableNativeConnector(
        stellaRoot,
        id,
        "store",
        {
          configuredBackendProviders: configuredOAuthProviders.backend,
          configuredExternalCallbackProviders:
            configuredOAuthProviders.externalCallback,
        },
        serverCatalog ?? undefined,
      );
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
      const serverCatalog = await loadServerNativeConnectorCatalog(options);
      const result = await disableNativeConnector(
        stellaRoot,
        id,
        {
          configuredBackendProviders: configuredOAuthProviders.backend,
          configuredExternalCallbackProviders:
            configuredOAuthProviders.externalCallback,
        },
        serverCatalog ?? undefined,
      );
      const entry = getNativeConnectorCatalogEntry(
        id,
        buildNativeConnectorCatalog(serverCatalog ?? undefined),
      );
      if (
        entry?.provider === "google-workspace" &&
        options.disconnectGoogleWorkspace
      ) {
        const remaining = await listNativeConnectors(
          stellaRoot,
          {},
          serverCatalog ?? undefined,
        );
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
