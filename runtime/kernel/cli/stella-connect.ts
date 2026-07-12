#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

import { callApiConnector } from "../connectors/api-client.js";
import {
  resolveNativeConnectorCatalog,
  type NativeCatalogSource,
} from "../connectors/catalog-cache.js";
import { getNativeConnectorReadiness } from "../connectors/connection-status.js";
import {
  requestConnectorConnectionFromBridge,
  requestConnectorCredentialFromBridge,
  requestConnectorTokenStoreFromBridge,
  requestStellaSiteAuthFromBridge,
  type ConnectorConnectionResult,
  type ConnectorCredentialResult,
} from "../connectors/cli-broker-client.js";
import {
  clearConnectorDecline,
  getConnectorDecline,
  recordConnectorDecline,
} from "../connectors/connect-preferences.js";
import { discoverConnectors } from "../connectors/discovery.js";
import {
  callConnectorBridgeTool,
  closeConnectorBridgeSessions,
  ConnectorAuthError,
  listConnectorBridgeTools,
} from "../connectors/connector-bridge.js";
import {
  listConfiguredApiConnectors,
  listConfiguredConnectorCommands,
  removeConfiguredConnector,
  saveConfiguredConnectorCommands,
} from "../connectors/state.js";
import {
  deleteConnectorAccessTokens,
  loadConnectorAccessToken,
  loadConnectorTokenPayload,
  setConnectorTokenStoreBroker,
} from "../connectors/oauth.js";
import {
  getNativeOAuthProviderConfig,
  type NativeOAuthProviderConfig,
} from "../connectors/native-oauth-provider-config.js";
import {
  backendIntegrationRunToolName,
  buildNativeConnectorCatalog,
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
  getNativeConnectorCatalogActions,
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  listNativeConnectors,
  nativeOAuthApiRequestToolName,
  type NativeConnectorCatalogEntry,
  type NativeConnectorCatalogOverride,
} from "../connectors/native-integrations.js";
import type {
  ConnectorCommandConfig,
  ConnectorToolInfo,
} from "../connectors/types.js";
import { loadGoogleWorkspaceTools } from "../google-workspace/load-google-workspace-tools.js";
import { resolveStatePath } from "./shared.js";

const stateRoot = path.resolve(resolveStatePath());
const stellaAppDir = stateRoot;

if (process.env.ELECTRON_RUN_AS_NODE === "1") {
  const requestTokenStore = async (
    request: Parameters<
      typeof requestConnectorTokenStoreFromBridge
    >[0]["request"],
  ) => {
    const socketPath = process.env.STELLA_CLI_BRIDGE_SOCK?.trim();
    if (!socketPath) {
      throw new Error(
        "stella-connect protected storage requires the desktop CLI bridge.",
      );
    }
    const result = await requestConnectorTokenStoreFromBridge({
      socketPath,
      request,
    });
    if (!result.ok) {
      throw new Error(`stella-connect protected storage: ${result.reason}`);
    }
    return result;
  };

  setConnectorTokenStoreBroker({
    load: async (tokenKey) => {
      const result = await requestTokenStore({ operation: "load", tokenKey });
      return result.payload ?? null;
    },
    save: async (tokenKey, payload) => {
      await requestTokenStore({ operation: "save", tokenKey, payload });
    },
    delete: async (tokenKeys) => {
      await requestTokenStore({ operation: "delete", tokenKeys });
    },
  });
}

const printJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/**
 * Expected refusals (user declined, bridge missing, timeout) exit 2 with
 * a structured `{ ok: false, error }` payload on stdout — same contract
 * as the `auth_required` envelope — so agents can branch on the outcome
 * without parsing prose.
 */
const exitStructured = (payload: Record<string, unknown>): never => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(2);
};

const parseJson = <T>(value: string | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    fail(`Invalid JSON: ${(error as Error).message}`);
  }
  return fallback;
};

const parseOptions = (argv: string[]) => {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      positionals.push(entry);
      continue;
    }
    const eqIndex = entry.indexOf("=");
    if (eqIndex > -1) {
      options[entry.slice(2, eqIndex)] = entry.slice(eqIndex + 1);
      continue;
    }
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
};

const optionString = (
  options: Record<string, string | boolean>,
  key: string,
): string | undefined => {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
};

const optionStringList = (
  options: Record<string, string | boolean>,
  key: string,
): string[] | undefined => {
  const value = optionString(options, key);
  if (!value) return undefined;
  const parsed = value.trim().startsWith("[")
    ? parseJson<string[]>(value, [])
    : value.split(",");
  return parsed.map((entry) => entry.trim()).filter(Boolean);
};

const safeId = (value: string) => {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\")
  ) {
    fail(`Invalid connector id: ${value}`);
  }
  return id;
};

/**
 * Run `attempt`. If it throws `ConnectorAuthError` AND the bridge socket
 * is wired AND the error carries a `tokenKey`, dial the bridge to pop a
 * credential dialog; on `{ ok: true }` retry once. Anything else (no
 * socket, no tokenKey, user cancel/timeout, second auth failure) falls
 * through to the caller's catch — the top-level handler renders the
 * structured `auth_required` envelope and exits 2.
 *
 * Single retry is intentional: a second auth failure means the user
 * pasted a bad key, not that we need another round-trip. The CLI exits
 * cleanly so the agent can decide whether to ask the user to try again.
 */
/**
 * Resolves the `authType` + `resourceUrl` for an auth-failed connector
 * so the bridge knows whether to pop a paste-key modal (`api_key`) or
 * kick off the browser OAuth flow (`oauth`). Both paths persist into
 * the same `.credentials.json[tokenKey]` slot; only the acquisition
 * method differs.
 *
 * `import-mcp` probes before persisting the new connector, so callers can
 * pass the in-memory command hints directly instead of depending on this
 * persisted-state lookup.
 */
type ConnectorAuthHints = {
  authType: "api_key" | "oauth" | undefined;
  resourceUrl?: string;
  oauthClientId?: string;
  oauthResource?: string;
  scopes?: string[];
  preregisteredOAuth?: {
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint?: string;
    responseType?: "code" | "token";
    resourceUrl?: string;
    oauthResource?: string | null;
    callbackUrl?: string;
    callbackId?: string;
    callbackMode?: "local" | "external";
    scopeSeparator?: string;
    usesPkce?: boolean;
    authorizationClientIdParam?: string;
    authorizationRedirectParam?: string;
    authorizationParams?: Record<string, string>;
    tokenRedirectParam?: string;
    tokenAuth?: "body" | "basic";
    tokenExchange?: {
      type: "backend";
      provider: string;
    };
  };
};

const nativeOAuthAuthHints = (
  id: string,
  config: NativeOAuthProviderConfig | null,
): ConnectorAuthHints | undefined => {
  if (!config) return undefined;
  if (config.flow !== "authorization_code") {
    return {
      authType: "oauth",
      resourceUrl: config.resourceUrl,
      oauthClientId: config.clientId,
      oauthResource: config.oauthResource ?? undefined,
      scopes: config.scopes,
    };
  }
  return {
    authType: "oauth",
    resourceUrl: config.resourceUrl ?? config.authorizationEndpoint,
    oauthClientId: config.clientId,
    oauthResource: config.oauthResource ?? undefined,
    scopes: config.scopes,
    preregisteredOAuth: {
      clientId: config.clientId,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      responseType: config.responseType,
      resourceUrl: config.resourceUrl,
      oauthResource: config.oauthResource,
      callbackUrl: config.callbackUrl,
      callbackId: config.callbackId,
      callbackMode: config.callbackMode,
      scopeSeparator: config.scopeSeparator,
      usesPkce: config.usesPkce,
      authorizationClientIdParam: config.authorizationClientIdParam,
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
    },
  };
};

const resolveConnectorAuthHints = async (
  serverDisplayName: string,
): Promise<ConnectorAuthHints> => {
  const commands = await listConfiguredConnectorCommands(stellaAppDir).catch(
    () => [],
  );
  const apis = await listConfiguredApiConnectors(stellaAppDir).catch(() => []);
  const command = commands.find(
    (entry) => entry.displayName === serverDisplayName,
  );
  if (command) {
    return {
      authType: command.auth?.type === "oauth" ? "oauth" : "api_key",
      resourceUrl: command.url,
      oauthClientId: command.auth?.clientId,
      oauthResource: command.auth?.resource,
      scopes: command.auth?.scopes,
    };
  }
  const api = apis.find((entry) => entry.displayName === serverDisplayName);
  if (api) {
    return {
      authType: api.auth?.type === "oauth" ? "oauth" : "api_key",
      resourceUrl: api.baseUrl,
      oauthClientId: api.auth?.clientId,
      oauthResource: api.auth?.resource,
      scopes: api.auth?.scopes,
    };
  }
  return { authType: undefined };
};

const withAuthRetry = async <T>(
  attempt: () => Promise<T>,
  explicitHints?: ConnectorAuthHints,
): Promise<T> => {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ConnectorAuthError)) throw error;
    const socketPath = process.env.STELLA_CLI_BRIDGE_SOCK;
    if (!socketPath || !error.tokenKey) throw error;

    const hints =
      explicitHints ??
      (await resolveConnectorAuthHints(error.serverDisplayName));

    let result: ConnectorCredentialResult;
    try {
      // No `description` — we deliberately let the renderer's canonical
      // copy fire instead of leaking the upstream HTTP status /
      // generic-error verbiage into a user-facing dialog.
      result = await requestConnectorCredentialFromBridge({
        socketPath,
        tokenKey: error.tokenKey,
        displayName: error.serverDisplayName,
        authType: hints.authType,
        resourceUrl: hints.resourceUrl,
        oauthClientId: hints.oauthClientId,
        oauthResource: hints.oauthResource,
        scopes: hints.scopes,
        preregisteredOAuth: hints.preregisteredOAuth,
      });
    } catch (bridgeError) {
      // The bridge was advertised but isn't reachable — fall through to
      // the original auth error so the agent gets a clean signal rather
      // than a confusing "socket refused" string.
      process.stderr.write(
        `[stella-connect] cli-bridge unreachable: ${(bridgeError as Error).message}\n`,
      );
      throw error;
    }

    if (!result.ok) throw error;
    return await attempt();
  }
};

const findCommand = async (id: string) => {
  const commands = await listConfiguredConnectorCommands(stellaAppDir);
  return commands.find((entry) => entry.id === id);
};

const findApi = async (id: string) => {
  const apis = await listConfiguredApiConnectors(stellaAppDir);
  return apis.find((entry) => entry.id === id);
};

const withConnectorBridgeCleanup = async <T>(
  command: ConnectorCommandConfig,
  attempt: () => Promise<T>,
): Promise<T> => {
  try {
    return await attempt();
  } finally {
    await closeConnectorBridgeSessions(stellaAppDir, [command.id]);
  }
};

// `toBackendComposioEntry` moved to `../connectors/catalog-cache.js` so the
// connector keyword index and the `connector_status` tool share the parser.

const loadStellaSiteAuth = async (options: { refresh?: boolean } = {}) => {
  const envBaseUrl =
    process.env.STELLA_CONVEX_SITE_URL?.trim() ||
    process.env.STELLA_SITE_URL?.trim() ||
    "";
  const envAuthToken =
    process.env.STELLA_NATIVE_OAUTH_BACKEND_AUTH_TOKEN?.trim() ||
    process.env.STELLA_SITE_AUTH_TOKEN?.trim() ||
    "";
  if (!options.refresh && envBaseUrl && envAuthToken) {
    return { ok: true as const, baseUrl: envBaseUrl, authToken: envAuthToken };
  }
  const socketPath = process.env.STELLA_CLI_BRIDGE_SOCK;
  if (!socketPath) return { ok: false as const, reason: "no_bridge" };
  return await requestStellaSiteAuthFromBridge({
    socketPath,
    refresh: options.refresh === true,
    timeoutMs: options.refresh ? 20_000 : 5_000,
  }).catch((error) => ({
    ok: false as const,
    reason: (error as Error).message || "bridge_unavailable",
  }));
};

const loadServerNativeCatalog = async () =>
  resolveNativeConnectorCatalog({
    stellaDataDir: stellaAppDir,
    getStellaSiteAuth: async () => {
      const siteAuth = await loadStellaSiteAuth();
      return siteAuth.ok
        ? { baseUrl: siteAuth.baseUrl, authToken: siteAuth.authToken }
        : null;
    },
  });

const nativeCatalogDiagnostics = (
  entry: NativeConnectorCatalogEntry,
  catalogSource: NativeCatalogSource,
) => {
  const toolCount = getNativeConnectorTools(entry).length;
  return {
    catalogSource,
    provider: entry.provider,
    toolCount,
  };
};

const callBackendNativeIntegration = async (
  id: string,
  action: string,
  input: Record<string, unknown>,
) => {
  let siteAuth = await loadStellaSiteAuth();
  if (!siteAuth.ok) {
    siteAuth = await loadStellaSiteAuth({ refresh: true });
  }
  const connectedSiteAuth = siteAuth.ok
    ? siteAuth
    : fail("Sign in to Stella before using this integration.");
  let activeAuth = {
    baseUrl: connectedSiteAuth.baseUrl,
    authToken: connectedSiteAuth.authToken,
  };
  const run = async (auth: { baseUrl: string; authToken: string }) =>
    await fetch(
      `${auth.baseUrl.replace(/\/+$/u, "")}/api/native-integrations/run`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${auth.authToken}`,
        },
        body: JSON.stringify({ id, action, input }),
      },
    );
  let response = await run(activeAuth);
  if (response.status === 401 || response.status === 403) {
    const refreshed = await loadStellaSiteAuth({ refresh: true });
    const refreshedSiteAuth = refreshed.ok
      ? refreshed
      : fail(
          "Stella sign-in expired. Sign in again before using this integration.",
        );
    activeAuth = {
      baseUrl: refreshedSiteAuth.baseUrl,
      authToken: refreshedSiteAuth.authToken,
    };
    response = await run(activeAuth);
    if (response.status === 401 || response.status === 403) {
      fail(
        "Stella sign-in could not be refreshed. Sign in again before using this integration.",
      );
    }
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Integration action failed (${response.status}).`;
    fail(message);
  }
  return payload;
};

const findNative = (
  id: string,
  catalogOverride?: NativeConnectorCatalogOverride,
) =>
  getNativeConnectorCatalogEntry(
    id,
    catalogOverride === undefined
      ? undefined
      : buildNativeConnectorCatalog(catalogOverride),
  );

const connectorAuthStatus = async (auth: ConnectorCommandConfig["auth"]) => {
  if (!auth || auth.type === "none") return "unsupported" as const;
  if (!auth.tokenKey) return "not_logged_in" as const;
  return (await loadConnectorAccessToken(stellaAppDir, auth.tokenKey))
    ? "connected"
    : "not_logged_in";
};

const ensureNativeEnabled = async (
  id: string,
  catalogOverride?: NativeConnectorCatalogOverride,
) => {
  const entry = findNative(id, catalogOverride);
  if (!entry) return null;
  if (!(await isNativeConnectorEnabled(stellaAppDir, id))) {
    fail(
      `${entry.name} is disabled. Enable it in the Store or run: stella-connect enable-native ${id}`,
    );
  }
  return entry;
};

const callNativeConnector = async (
  id: string,
  action: string,
  args: {
    body: Record<string, unknown>;
    method?: string;
    query?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
  },
  catalogOverride?: NativeConnectorCatalogOverride,
) => {
  const entry = await ensureNativeEnabled(id, catalogOverride);
  if (!entry) return null;
  if (
    entry.provider !== "backend-composio" &&
    entry.localExecution !== "production-ready"
  ) {
    fail(
      `${entry.name} local execution is incomplete. A live or cached authoritative Store catalog entry is required.`,
    );
  }
  if (entry.provider === "backend-composio") {
    const runAction = backendIntegrationRunToolName(id);
    if (action === runAction) {
      const nestedAction = args.body.action;
      if (typeof nestedAction !== "string" || !nestedAction.trim()) {
        fail(`${runAction} requires an action string.`);
      }
      const nestedActionName = (nestedAction as string).trim();
      const nestedArgs = args.body.arguments;
      return await callBackendNativeIntegration(
        id,
        nestedActionName,
        nestedArgs &&
          typeof nestedArgs === "object" &&
          !Array.isArray(nestedArgs)
          ? (nestedArgs as Record<string, unknown>)
          : {},
      );
    }
    return await callBackendNativeIntegration(id, action, args.body);
  }
  const allowedTools = new Set(
    getNativeConnectorTools(entry).map((tool) => tool.name),
  );
  if (
    entry.provider === "oauth-catalog" &&
    id === "linear" &&
    action === "LINEAR_RUN_QUERY_OR_MUTATION"
  ) {
    if (typeof args.body.query !== "string" || !args.body.query.trim()) {
      fail("LINEAR_RUN_QUERY_OR_MUTATION requires a GraphQL `query` string.");
    }
    const config = getNativeOAuthProviderConfig(id);
    const tokenPayload = config?.tokenKey
      ? await loadConnectorTokenPayload(stellaAppDir, config.tokenKey)
      : null;
    const baseUrl =
      tokenPayload?.resourceUrl ??
      config?.resourceUrl ??
      fail(`${entry.name} does not expose a native GraphQL endpoint yet.`);
    const tokenKey =
      config?.tokenKey ??
      fail(`${entry.name} does not expose a native GraphQL endpoint yet.`);
    return await withAuthRetry(
      () =>
        callApiConnector(
          stellaAppDir,
          {
            id,
            displayName: entry.name,
            baseUrl,
            auth: {
              type: "oauth",
              tokenKey,
              scheme: "bearer",
              headerName: "Authorization",
            },
          },
          {
            method: "POST",
            path: "/graphql",
            body: args.body,
          },
        ),
      nativeOAuthAuthHints(id, config),
    );
  }
  const callNativeOAuthApiPath = async (
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | boolean>;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ) => {
    const config = getNativeOAuthProviderConfig(id);
    const tokenKey =
      config?.tokenKey ??
      fail(`${entry.name} does not expose a native REST endpoint yet.`);
    const tokenInQuery = config?.apiAuthPlacement === "access_token_query";
    const attempt = async () => {
      const tokenPayload = await loadConnectorTokenPayload(
        stellaAppDir,
        tokenKey,
      );
      const baseUrl =
        tokenPayload?.resourceUrl ??
        config?.resourceUrl ??
        fail(`${entry.name} does not expose a native REST endpoint yet.`);
      if (tokenInQuery && !tokenPayload?.accessToken) {
        throw new ConnectorAuthError(
          0,
          entry.name,
          tokenKey,
          `${entry.name} is not connected yet.`,
        );
      }
      const queryAccessToken =
        tokenInQuery && tokenPayload?.accessToken
          ? tokenPayload.accessToken
          : null;
      return await callApiConnector(
        stellaAppDir,
        {
          id,
          displayName: entry.name,
          baseUrl,
          auth: tokenInQuery
            ? { type: "none" }
            : {
                type: "oauth",
                tokenKey,
                scheme: config?.apiAuthScheme ?? "bearer",
                headerName: "Authorization",
              },
        },
        {
          method: options.method,
          path,
          query: {
            ...(config?.apiQueryParams ?? {}),
            ...(queryAccessToken ? { access_token: queryAccessToken } : {}),
            ...(options.query ?? {}),
          },
          body:
            options.body && Object.keys(options.body).length
              ? options.body
              : undefined,
          headers: options.headers,
        },
      );
    };
    return await withAuthRetry(attempt, nativeOAuthAuthHints(id, config));
  };
  if (entry.provider === "oauth-catalog" && action.startsWith("/")) {
    return await callNativeOAuthApiPath(action, {
      method: args.method,
      query: args.query,
      body: args.body,
      headers: args.headers,
    });
  }
  if (
    entry.provider === "oauth-catalog" &&
    action === nativeOAuthApiRequestToolName(id)
  ) {
    const path = args.body.path;
    if (typeof path !== "string" || !path.startsWith("/")) {
      fail(`${action} requires a \`path\` string beginning with /.`);
    }
    const apiPath = path as string;
    const method = args.body.method;
    const query = args.body.query;
    const body = args.body.body;
    const headers = args.body.headers;
    return await callNativeOAuthApiPath(apiPath, {
      method: typeof method === "string" ? method : args.method,
      query:
        query && typeof query === "object" && !Array.isArray(query)
          ? (query as Record<string, string | number | boolean>)
          : args.query,
      body:
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {},
      headers:
        headers && typeof headers === "object" && !Array.isArray(headers)
          ? Object.fromEntries(
              Object.entries(headers).flatMap(([key, value]) =>
                typeof value === "string" ? [[key, value]] : [],
              ),
            )
          : args.headers,
    });
  }
  if (!allowedTools.has(action)) {
    fail(
      `${entry.name} does not expose ${action}. Run: stella-connect tools ${id}`,
    );
  }
  if (entry.provider !== "google-workspace") {
    fail(
      `${entry.name} is connected for OAuth catalog metadata, but Stella does not have a native tool dispatcher for it yet.`,
    );
  }
  const { callTool, disconnect } = await loadGoogleWorkspaceTools({
    stellaAppDir,
  });
  try {
    const googleCallTool = callTool;
    if (googleCallTool) return await googleCallTool(action, args.body);
    fail("Google Workspace tools are unavailable.");
  } finally {
    await disconnect().catch(() => undefined);
  }
};

const writeGeneratedSkill = async (
  command: ConnectorCommandConfig,
  tools: ConnectorToolInfo[],
  { probeDeferred }: { probeDeferred: boolean } = { probeDeferred: false },
) => {
  const skillDir = path.join(stateRoot, "skills", command.id);
  await fs.mkdir(skillDir, { recursive: true });
  const toolLines = tools.length
    ? tools
        .map((tool) => {
          const description = tool.description ? ` - ${tool.description}` : "";
          return `- \`${tool.name}\`${description}`;
        })
        .join("\n")
    : probeDeferred
      ? `- _Actions list deferred until credentials are configured. Bind the token for \`${command.auth?.tokenKey ?? command.id}\`, then run \`stella-connect refresh-skill ${command.id}\`._`
      : "- Run `stella-connect tools <connector>` to inspect available actions.";
  const description =
    command.description ??
    `Use the ${command.displayName} connector from Stella.`;
  const body = `---
name: ${command.id}
description: ${description.replace(/\n+/g, " ")}
---

# ${command.displayName}

Use this skill for work that needs ${command.displayName}.

Inspect available actions:

\`\`\`bash
stella-connect tools ${command.id}
\`\`\`

Call an action:

\`\`\`bash
stella-connect call ${command.id} <action-name> --json '{"key":"value"}'
\`\`\`

## Actions

${toolLines}
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf-8");
  return path.join(skillDir, "SKILL.md");
};

const importMcp = async (argv: string[]) => {
  const { options } = parseOptions(argv);
  const id = safeId(optionString(options, "id") ?? "");
  const displayName = optionString(options, "name") ?? id;
  const description = optionString(options, "description");
  const url = optionString(options, "url");
  const commandName = optionString(options, "command");
  const args = parseJson<string[]>(optionString(options, "args-json"), []);
  const env = parseJson<Record<string, string>>(
    optionString(options, "env-json"),
    {},
  );
  const cwd = optionString(options, "cwd");
  const authType = optionString(options, "auth-type") as
    | "none"
    | "api_key"
    | "oauth"
    | undefined;
  const authTokenKey = optionString(options, "auth-token-key");
  const authHeaderName = optionString(options, "auth-header-name");
  const authScheme = optionString(options, "auth-scheme") as
    | "bearer"
    | "basic"
    | "oauth"
    | "raw"
    | undefined;
  const authEnvVar = optionString(options, "auth-env-var");
  const oauthClientId =
    optionString(options, "oauth-client-id") ??
    optionString(options, "auth-client-id");
  const oauthResource =
    optionString(options, "oauth-resource") ??
    optionString(options, "auth-resource");
  const oauthScopes =
    optionStringList(options, "oauth-scopes") ??
    optionStringList(options, "auth-scopes") ??
    parseJson<string[] | undefined>(
      optionString(options, "oauth-scopes-json"),
      undefined,
    );

  if (!url && !commandName) {
    fail("Provide either --url or --command.");
  }
  if (url && commandName) {
    fail("Provide only one of --url or --command.");
  }

  const auth: ConnectorCommandConfig["auth"] =
    authType && authType !== "none"
      ? {
          type: authType,
          ...(authTokenKey ? { tokenKey: authTokenKey } : {}),
          ...(authHeaderName ? { headerName: authHeaderName } : {}),
          ...(authScheme ? { scheme: authScheme } : {}),
          ...(authEnvVar ? { envVar: authEnvVar } : {}),
          ...(oauthClientId ? { clientId: oauthClientId } : {}),
          ...(oauthResource ? { resource: oauthResource } : {}),
          ...(oauthScopes?.length ? { scopes: oauthScopes } : {}),
        }
      : { type: "none" };

  const command: ConnectorCommandConfig = url
    ? {
        id,
        displayName,
        description,
        transport: "streamable_http",
        url,
        auth,
      }
    : {
        id,
        displayName,
        description,
        transport: "stdio",
        command: commandName,
        args,
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        auth,
      };

  // Probe via `withAuthRetry` so an authenticated hosted MCP can pop the
  // credential dialog inline at import time — user pastes the key, the
  // host writes it via `saveConnectorAccessToken`, and the probe is
  // retried with the token attached. If the bridge isn't wired (e.g.
  // the worker started without it) OR the user dismisses the dialog,
  // we still fall back to writing a stub skill so the import isn't
  // lost; the agent can `refresh-skill <id>` after the credential is
  // bound out-of-band. Non-auth probe failures still surface loudly.
  let tools: ConnectorToolInfo[] = [];
  let probeDeferred = false;
  let probeDeferredReason: string | undefined;
  try {
    tools = await withConnectorBridgeCleanup(command, () =>
      withAuthRetry(() => listConnectorBridgeTools(stellaAppDir, command), {
        authType: command.auth?.type === "oauth" ? "oauth" : "api_key",
        resourceUrl: command.url,
        oauthClientId: command.auth?.clientId,
        oauthResource: command.auth?.resource,
        scopes: command.auth?.scopes,
      }),
    );
  } catch (error) {
    if (error instanceof ConnectorAuthError && auth.type !== "none") {
      probeDeferred = true;
      probeDeferredReason = error.message;
    } else {
      throw error;
    }
  }

  const existing = await listConfiguredConnectorCommands(stellaAppDir);
  const next = new Map(existing.map((entry) => [entry.id, entry]));
  next.set(id, command);
  await saveConfiguredConnectorCommands(
    stellaAppDir,
    [...next.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
  );
  const skillPath = await writeGeneratedSkill(command, tools, {
    probeDeferred,
  });
  printJson({
    imported: command,
    tools,
    skillPath,
    ...(probeDeferred
      ? {
          probeDeferred: true,
          probeDeferredReason,
          hint: auth.tokenKey
            ? `Bind the credential under tokenKey "${auth.tokenKey}" (~/.stella/connectors/.credentials.json), then run \`stella-connect refresh-skill ${id}\` to populate the action list.`
            : `Configure auth, then run \`stella-connect refresh-skill ${id}\` to populate the action list.`,
        }
      : {}),
  });
};

const refreshSkill = async (id: string) => {
  const command = await findCommand(id);
  if (!command) fail(`Connector command is not installed: ${id}`);
  if (!command) return;
  const tools = await withConnectorBridgeCleanup(command, () =>
    withAuthRetry(() => listConnectorBridgeTools(stellaAppDir, command)),
  );
  const skillPath = await writeGeneratedSkill(command, tools, {
    probeDeferred: false,
  });
  printJson({ refreshed: command.id, tools, skillPath });
};

const HELP_TEXT = [
  "Usage: stella-connect <command>",
  "Commands:",
  "  installed                         List configured CLI/API/native connectors.",
  "  apps                              List native Store integrations and enabled state.",
  "  discover <keywords>               Search the full integration catalog (Store natives +",
  "                                    imported connectors) and report enabled/connected/",
  "                                    declined state for the best matches.",
  '  request-connection <id> [--reason "..."] [--requested-by-user]',
  "                                    Offer connecting a Store integration via an inline",
  "                                    connect card in the chat; blocks until the user",
  "                                    accepts (then OAuth + enable run) or declines.",
  "  enable-native <id>                Enable a native Store integration and write its skill.",
  "  disable-native <id>               Disable a native Store integration and remove its generated skill.",
  "  import-mcp --id <id> (--url <u> | --command <cmd> [--args-json '[]'])",
  "                                    Probe an MCP, persist it as a CLI connector, and",
  "                                    generate a matching skill under ~/.stella/skills/<id>/.",
  "                                    For authenticated hosted MCPs, declare auth with",
  "                                    --auth-type/--auth-token-key/--auth-header-name/",
  "                                    --auth-scheme/--auth-env-var; OAuth also supports",
  "                                    --oauth-client-id/--oauth-resource/--oauth-scopes.",
  "                                    The probe is deferred",
  "                                    until credentials land. Run `refresh-skill` after.",
  "  refresh-skill <id>                Re-probe a configured connector and rewrite its skill.",
  "  tools <id>                        List actions for a configured connector.",
  "  tools-diagnostics <id>            List actions plus source/provider/readiness diagnostics.",
  "  catalog-actions <id>              List recovered native OAuth catalog action references.",
  "  call <id> <action-or-path> [--json '{}'] [--method GET] [--query-json '{}'] [--header-json '{}']",
  "                                    Invoke a connector action or REST path.",
  "  remove <id>                       Remove a configured connector (state only).",
].join("\n");

const main = async () => {
  const [commandName, ...rest] = process.argv.slice(2);
  const resolvedNativeCatalog = await loadServerNativeCatalog();
  const serverNativeCatalog = resolvedNativeCatalog.entries;
  const catalogSource = resolvedNativeCatalog.source;
  const catalogSources = resolvedNativeCatalog.sources;
  switch (commandName) {
    case "installed": {
      const [commands, apis, native] = await Promise.all([
        listConfiguredConnectorCommands(stellaAppDir),
        listConfiguredApiConnectors(stellaAppDir),
        listNativeConnectors(stellaAppDir, {}, serverNativeCatalog),
      ]);
      printJson({
        commands: await Promise.all(
          commands.map(async (command) => ({
            ...command,
            authStatus: await connectorAuthStatus(command.auth),
          })),
        ),
        apis: await Promise.all(
          apis.map(async (api) => ({
            ...api,
            authStatus: await connectorAuthStatus(api.auth),
          })),
        ),
        native: await Promise.all(
          native
            .filter((entry) => entry.enabled)
            .map(async (entry) => {
              const readiness = await getNativeConnectorReadiness(
                stellaAppDir,
                entry,
              );
              return {
                ...entry,
                authStatus: readiness.authStatus,
                accountVerified: readiness.accountVerified,
                executable: readiness.executable,
                ...nativeCatalogDiagnostics(
                  entry,
                  catalogSources[entry.id] ?? catalogSource,
                ),
              };
            }),
        ),
      });
      return;
    }
    case "discover":
    case "find": {
      const { positionals } = parseOptions(rest);
      const query = positionals.join(" ").trim();
      if (!query) fail("Usage: stella-connect discover <keywords>");
      const native = await listNativeConnectors(
        stellaAppDir,
        {},
        serverNativeCatalog,
      );
      const enabledNativeIds = new Set(
        native.filter((entry) => entry.enabled).map((entry) => entry.id),
      );
      const matches = await discoverConnectors(stellaAppDir, query, {
        catalogOverride: serverNativeCatalog,
        enabledNativeIds,
      });
      const enriched = await Promise.all(
        matches.map(async (match) => {
          let connected = false;
          let nativeEntry: NativeConnectorCatalogEntry | undefined;
          let nativeReadiness:
            | Awaited<ReturnType<typeof getNativeConnectorReadiness>>
            | undefined;
          if (match.kind === "native") {
            nativeEntry = findNative(match.id, serverNativeCatalog);
            nativeReadiness = nativeEntry
              ? await getNativeConnectorReadiness(stellaAppDir, nativeEntry)
              : undefined;
            connected = nativeReadiness?.executable ?? false;
          } else {
            const config =
              match.kind === "mcp"
                ? await findCommand(match.id)
                : await findApi(match.id);
            const authStatus = await connectorAuthStatus(config?.auth);
            // "unsupported" means the connector needs no credential —
            // it is usable as-is.
            connected =
              authStatus === "connected" || authStatus === "unsupported";
          }
          const next = connected
            ? `Ready. Inspect actions: stella-connect tools ${match.id}`
            : match.declined
              ? "The user previously declined connecting this in chat. Do not offer it again; they can enable it in the Store. Only rerun request-connection with --requested-by-user if the user explicitly asks to connect it now."
              : match.kind === "native"
                ? "Not connected. Connect offers are handled by the orchestrator's inline connect card (or the Store) — do not initiate one from here unless the user explicitly asked this turn (then: stella-connect request-connection). Proceed via the browser/computer fallback meanwhile."
                : `Configured but not authorized. Calling it pops the auth dialog: stella-connect tools ${match.id}`;
          return {
            id: match.id,
            name: match.name,
            kind: match.kind,
            ...(match.category ? { category: match.category } : {}),
            description: match.description,
            enabled: match.enabled,
            connected,
            ...(match.kind === "native" && nativeEntry
              ? {
                  ...nativeCatalogDiagnostics(
                    nativeEntry,
                    catalogSources[nativeEntry.id] ?? catalogSource,
                  ),
                  providerStatus: nativeReadiness?.authStatus,
                  accountVerified: nativeReadiness?.accountVerified ?? false,
                  executable: nativeReadiness?.executable ?? false,
                }
              : {}),
            declined: match.declined,
            next,
          };
        }),
      );
      printJson({ query, matches: enriched });
      return;
    }
    case "request-connection": {
      const { positionals, options } = parseOptions(rest);
      const id = positionals[0];
      if (!id) {
        fail(
          'Usage: stella-connect request-connection <integration-id> [--reason "..."] [--requested-by-user]',
        );
      }
      const entry = findNative(id, serverNativeCatalog);
      if (!entry) {
        fail(
          `Unknown native integration: ${id}. Imported MCP/API connectors do not need this — calling them pops the auth dialog automatically.`,
        );
      }
      if (!entry) return;
      const enabled = await isNativeConnectorEnabled(stellaAppDir, entry.id);
      const readiness = await getNativeConnectorReadiness(stellaAppDir, entry);
      const skillPath = `~/.stella/skills/${entry.id}/SKILL.md`;
      if (enabled && readiness.executable) {
        printJson({
          ok: true,
          status: "already_connected",
          id: entry.id,
          skillPath,
          hint: `Proceed with the task. Inspect actions: stella-connect tools ${entry.id}`,
        });
        return;
      }
      if (
        readiness.toolCount === 0 ||
        !entry.connectable ||
        (entry.provider !== "backend-composio" &&
          entry.localExecution !== "production-ready")
      ) {
        exitStructured({
          ok: false,
          error: "connector_unavailable",
          id: entry.id,
          catalogSource: catalogSources[entry.id] ?? catalogSource,
          provider: entry.provider,
          providerStatus: readiness.authStatus,
          enabled,
          toolCount: readiness.toolCount,
          executable: readiness.executable,
          message:
            entry.localExecution === "incomplete"
              ? `${entry.name} is available only as incomplete/deprecated bundled metadata. A live or cached authoritative Store catalog entry is required; no connection card was shown.`
              : `${entry.name} does not currently expose a connectable executable integration; no connection card was shown.`,
        });
      }
      const requestedByUser = options["requested-by-user"] === true;
      const decline = await getConnectorDecline(stellaAppDir, entry.id);
      if (decline && !requestedByUser) {
        exitStructured({
          ok: false,
          error: "previously_declined",
          id: entry.id,
          declinedAt: decline.declinedAt,
          message: `The user previously declined connecting ${entry.name} from chat. Do not offer it again; they can enable it anytime in the Store. If the user explicitly asks to connect it now, rerun with --requested-by-user.`,
        });
      }
      const socketPath = process.env.STELLA_CLI_BRIDGE_SOCK;
      if (!socketPath) {
        exitStructured({
          ok: false,
          error: "bridge_unavailable",
          id: entry.id,
          message: `The desktop bridge is not available in this session, so the in-chat connect card cannot be shown. Ask the user to enable ${entry.name} in the Store.`,
        });
      }
      let result: ConnectorConnectionResult;
      try {
        result = await requestConnectorConnectionFromBridge({
          socketPath: socketPath!,
          id: entry.id,
          name: entry.name,
          description: entry.description,
          iconUrl: entry.iconUrl,
          category: entry.category,
          reason: optionString(options, "reason"),
        });
      } catch (bridgeError) {
        process.stderr.write(
          `[stella-connect] cli-bridge unreachable: ${(bridgeError as Error).message}\n`,
        );
        exitStructured({
          ok: false,
          error: "bridge_unavailable",
          id: entry.id,
          message: `The in-chat connect card could not be shown. Ask the user to enable ${entry.name} in the Store.`,
        });
        return;
      }
      if (result.ok) {
        // The desktop's enable path clears the decline too; clearing
        // here as well keeps the file correct when the enable happened
        // in a different process context.
        await clearConnectorDecline(stellaAppDir, entry.id).catch(
          () => undefined,
        );
        printJson({
          ok: true,
          status: result.status,
          id: entry.id,
          skillPath,
          hint: `${entry.name} is connected. Proceed with the user's original request now — do not re-ask what they wanted. Inspect actions: stella-connect tools ${entry.id}`,
        });
        return;
      }
      if (result.reason === "declined") {
        await recordConnectorDecline(stellaAppDir, entry.id).catch(
          () => undefined,
        );
        exitStructured({
          ok: false,
          error: "declined",
          id: entry.id,
          message: `The user declined connecting ${entry.name}. Acknowledge briefly once, mention they can enable it later in the Store, and continue helping by other means. Do not offer this connection again.`,
        });
      }
      exitStructured({
        ok: false,
        error: result.reason,
        id: entry.id,
        message:
          result.reason === "timeout"
            ? `The connect card timed out without a response. Continue without ${entry.name}; the user can enable it in the Store later.`
            : `Could not connect ${entry.name}: ${result.reason}. Continue without it, or suggest the Store if the user wants it set up.`,
      });
      return;
    }
    case "apps": {
      const native = await listNativeConnectors(
        stellaAppDir,
        {},
        serverNativeCatalog,
      );
      printJson(
        await Promise.all(
          native.map(async (entry) => {
            const readiness = await getNativeConnectorReadiness(
              stellaAppDir,
              entry,
            );
            return {
              ...entry,
              authStatus: readiness.authStatus,
              accountVerified: readiness.accountVerified,
              executable: readiness.executable,
              ...nativeCatalogDiagnostics(
                entry,
                catalogSources[entry.id] ?? catalogSource,
              ),
            };
          }),
        ),
      );
      return;
    }
    case "enable-native": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect enable-native <integration-id>");
      printJson(
        await enableNativeConnector(
          stellaAppDir,
          id,
          "cli",
          {},
          serverNativeCatalog,
        ),
      );
      return;
    }
    case "disable-native": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect disable-native <integration-id>");
      printJson(
        await disableNativeConnector(stellaAppDir, id, {}, serverNativeCatalog),
      );
      return;
    }
    case "tools": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect tools <connector-id>");
      const native = findNative(id, serverNativeCatalog);
      if (native) {
        await ensureNativeEnabled(id, serverNativeCatalog);
        const tools = getNativeConnectorTools(native);
        printJson(tools);
        return;
      }
      const command = await findCommand(id);
      if (!command) fail(`Connector command is not installed: ${id}`);
      if (!command) return;
      const tools = await withConnectorBridgeCleanup(command, () =>
        withAuthRetry(() => listConnectorBridgeTools(stellaAppDir, command)),
      );
      printJson(tools);
      return;
    }
    case "tools-diagnostics": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect tools-diagnostics <connector-id>");
      const native = findNative(id, serverNativeCatalog);
      if (native) {
        await ensureNativeEnabled(id, serverNativeCatalog);
        const readiness = await getNativeConnectorReadiness(
          stellaAppDir,
          native,
        );
        printJson({
          ...nativeCatalogDiagnostics(
            native,
            catalogSources[native.id] ?? catalogSource,
          ),
          providerStatus: readiness.authStatus,
          accountVerified: readiness.accountVerified,
          enabled: readiness.enabled,
          executable: readiness.executable,
          tools: getNativeConnectorTools(native),
        });
        return;
      }
      const command = await findCommand(id);
      if (!command) fail(`Connector command is not installed: ${id}`);
      if (!command) return;
      const tools = await withConnectorBridgeCleanup(command, () =>
        withAuthRetry(() => listConnectorBridgeTools(stellaAppDir, command)),
      );
      printJson({
        catalogSource: "imported",
        provider: "mcp",
        toolCount: tools.length,
        executable: tools.length > 0,
        tools,
      });
      return;
    }
    case "catalog-actions": {
      const id = rest[0];
      if (!id)
        fail("Usage: stella-connect catalog-actions <native-integration-id>");
      const native = findNative(id, serverNativeCatalog);
      if (!native) fail(`Native integration is not installed: ${id}`);
      if (!native) return;
      printJson(getNativeConnectorCatalogActions(native));
      return;
    }
    case "call": {
      const { positionals, options } = parseOptions(rest);
      const id = positionals[0];
      const target = positionals[1];
      if (!id || !target) {
        fail(
          "Usage: stella-connect call <connector-id> <tool-or-api-path> [--json '{}']",
        );
      }
      const body = parseJson<Record<string, unknown>>(
        optionString(options, "json"),
        {},
      );
      if (findNative(id, serverNativeCatalog)) {
        printJson(
          await callNativeConnector(
            id,
            target,
            {
              body,
              method: optionString(options, "method"),
              query: parseJson<Record<string, string | number | boolean>>(
                optionString(options, "query-json"),
                {},
              ),
              headers: parseJson<Record<string, string>>(
                optionString(options, "header-json"),
                {},
              ),
            },
            serverNativeCatalog,
          ),
        );
        return;
      }
      if (target.startsWith("/")) {
        const api = await findApi(id);
        if (!api) fail(`API connector is not installed: ${id}`);
        if (!api) return;
        printJson(
          await withAuthRetry(() =>
            callApiConnector(stellaAppDir, api, {
              method: optionString(options, "method"),
              path: target,
              query: parseJson<Record<string, string | number | boolean>>(
                optionString(options, "query-json"),
                {},
              ),
              body: Object.keys(body).length ? body : undefined,
              headers: parseJson<Record<string, string>>(
                optionString(options, "header-json"),
                {},
              ),
            }),
          ),
        );
        return;
      }
      const command = await findCommand(id);
      if (!command) fail(`Connector command is not installed: ${id}`);
      if (!command) return;
      printJson(
        await withConnectorBridgeCleanup(command, () =>
          withAuthRetry(() =>
            callConnectorBridgeTool(stellaAppDir, command, target, body),
          ),
        ),
      );
      return;
    }
    case "import-mcp": {
      await importMcp(rest);
      return;
    }
    case "refresh-skill": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect refresh-skill <connector-id>");
      await refreshSkill(id);
      return;
    }
    case "remove": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect remove <connector-id>");
      if (findNative(id, serverNativeCatalog)) {
        printJson(
          await disableNativeConnector(
            stellaAppDir,
            id,
            {},
            serverNativeCatalog,
          ),
        );
        return;
      }
      const removed = await removeConfiguredConnector(stellaAppDir, id);
      await closeConnectorBridgeSessions(stellaAppDir, [id]);
      await deleteConnectorAccessTokens(stellaAppDir, [
        ...removed.removedCommands.map((command) => command.auth?.tokenKey),
        ...removed.removedApis.map((api) => api.auth?.tokenKey),
      ]);
      printJson(removed);
      return;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP_TEXT}\n`);
      return;
    default:
      fail(HELP_TEXT);
  }
};

main().catch((error) => {
  if (error instanceof ConnectorAuthError) {
    // Structured payload so callers (including the agent) can detect
    // auth failures without parsing the human-readable message. Exit 2
    // distinguishes auth failures from generic errors (exit 1).
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: "auth_required",
          status: error.status,
          tokenKey: error.tokenKey,
          displayName: error.serverDisplayName,
          message: error.message,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(2);
  }
  fail((error as Error).message);
});
