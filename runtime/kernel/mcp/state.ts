import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getOfficialConnector, OFFICIAL_CONNECTOR_DEFINITIONS, type OfficialConnectorDefinition } from "./official-connectors.js";
import type { ApiConnectorConfig, ConnectorConfigField, McpServerConfig, StellaConnectorRecord } from "./types.js";

const safeName = (value: string) => {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid connector name: ${value}`);
  }
  return name;
};

const readJson = async <T = unknown>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
};

const interpolateString = (value: string, config: Record<string, string>) =>
  value.replace(/\$\{([a-zA-Z0-9_.-]+)\}/gu, (_match, key: string) => config[key] ?? "");

const interpolateConfig = <T>(value: T, config: Record<string, string>): T => {
  if (typeof value === "string") return interpolateString(value, config) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateConfig(entry, config)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateConfig(entry, config)]),
    ) as T;
  }
  return value;
};

const getInterpolationConfig = (
  config: Record<string, string>,
  fields: ConnectorConfigField[] = [],
) => {
  const secretKeys = new Set(fields.filter((field) => field.secret).map((field) => field.key));
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !secretKeys.has(key)),
  );
};

export const getMcpStateRoot = (stellaRoot: string) =>
  path.join(stellaRoot, "state", "mcp");

export const getConfiguredServersPath = (stellaRoot: string) =>
  path.join(getMcpStateRoot(stellaRoot), "servers.json");

export const getConfiguredApiConnectorsPath = (stellaRoot: string) =>
  path.join(getMcpStateRoot(stellaRoot), "api-connectors.json");

const getCodexMarketplaceRoot = () =>
  process.env.STELLA_CONNECT_PLUGIN_MARKETPLACE_ROOT ??
  path.join(os.homedir(), ".codex", ".tmp", "plugins");

const listLocalMarketplaceEntries = async (): Promise<StellaConnectorRecord[]> => {
  const root = getCodexMarketplaceRoot();
  const marketplace = await readJson<{ plugins?: Array<Record<string, unknown>> }>(
    path.join(root, ".agents", "plugins", "marketplace.json"),
  );
  const plugins = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
  const entries: StellaConnectorRecord[] = [];

  for (const plugin of plugins) {
    const key = typeof plugin.name === "string" ? plugin.name : "";
    if (!key) continue;
    const sourcePath = path.resolve(root, String((plugin.source as { path?: unknown } | undefined)?.path ?? ""));
    const manifest =
      (await readJson<Record<string, unknown>>(path.join(sourcePath, ".stella-plugin", "plugin.json"))) ??
      (await readJson<Record<string, unknown>>(path.join(sourcePath, ".codex-plugin", "plugin.json"))) ??
      (await readJson<Record<string, unknown>>(path.join(sourcePath, "plugin.json")));
    const appConfig = await readJson<{ apps?: Record<string, { id?: string }> }>(
      path.join(sourcePath, ".app.json"),
    );
    const mcpConfig = await readJson<{ mcpServers?: Record<string, unknown> } | Record<string, unknown>>(
      path.join(sourcePath, ".mcp.json"),
    );

    const appIds = Object.values(appConfig?.apps ?? {})
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === "string");
    const mcpServers = Object.keys(
      ((mcpConfig as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ??
        mcpConfig ??
        {}) as Record<string, unknown>,
    );
    if (appIds.length === 0 && mcpServers.length === 0) continue;

    const interfaceData = manifest?.interface as Record<string, unknown> | undefined;
    const displayName =
      (typeof interfaceData?.displayName === "string" && interfaceData.displayName) ||
      (typeof manifest?.name === "string" && manifest.name) ||
      key;
    const official = getOfficialConnector(key);
    if (!official) continue;
    const executable = Boolean(official.servers?.length || official.apis?.length);
    const requiresCredential = officialConnectorRequiresSetup(official);
    entries.push({
      id: safeName(key),
      marketplaceKey: key,
      displayName,
      description:
        (typeof interfaceData?.shortDescription === "string" && interfaceData.shortDescription) ||
        (typeof manifest?.description === "string" && manifest.description) ||
        undefined,
      category:
        (typeof plugin.category === "string" && plugin.category) ||
        (typeof interfaceData?.category === "string" && interfaceData.category) ||
        undefined,
      appIds,
      mcpServers,
      officialSource: official?.officialSource,
      integrationPath: official?.integrationPath,
      auth: official?.auth,
      configFields: official?.configFields,
      executable,
      requiresCredential,
      status: official.status,
      installed: false,
    });
  }

  entries.sort((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }),
  );
  return entries;
};

export const listStellaConnectors = async (
  stellaRoot: string,
): Promise<StellaConnectorRecord[]> => {
  const [entries, servers, apis] = await Promise.all([
    listLocalMarketplaceEntries(),
    listConfiguredMcpServers(stellaRoot),
    listConfiguredApiConnectors(stellaRoot),
  ]);
  const installedKeys = new Set(
    [...servers, ...apis]
      .map((entry) => entry.source?.marketplaceKey)
      .filter((key): key is string => Boolean(key)),
  );
  return entries.map((entry) => ({
    ...entry,
    installed: installedKeys.has(entry.marketplaceKey),
    status: installedKeys.has(entry.marketplaceKey) ? "implemented" : entry.status,
  }));
};

export const officialConnectorRequiresSetup = (
  connector: OfficialConnectorDefinition,
) =>
  Boolean(
    connector.configFields?.length ||
      connector.apis?.some((api) => api.auth && api.auth.type !== "none") ||
      connector.servers?.some((server) => server.auth && server.auth.type !== "none"),
  );

export const listConfiguredApiConnectors = async (
  stellaRoot: string,
): Promise<ApiConnectorConfig[]> => {
  const configured = await readJson<{ apis?: ApiConnectorConfig[] }>(
    getConfiguredApiConnectorsPath(stellaRoot),
  );
  return Array.isArray(configured?.apis) ? configured.apis : [];
};

export const saveConfiguredApiConnectors = async (
  stellaRoot: string,
  apis: ApiConnectorConfig[],
) => {
  const filePath = getConfiguredApiConnectorsPath(stellaRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ apis }, null, 2)}\n`, "utf-8");
};

export const listConfiguredMcpServers = async (
  stellaRoot: string,
): Promise<McpServerConfig[]> => {
  const configured = await readJson<{ servers?: McpServerConfig[] }>(
    getConfiguredServersPath(stellaRoot),
  );
  return Array.isArray(configured?.servers) ? configured.servers : [];
};

export const saveConfiguredMcpServers = async (
  stellaRoot: string,
  servers: McpServerConfig[],
) => {
  const filePath = getConfiguredServersPath(stellaRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ servers }, null, 2)}\n`,
    "utf-8",
  );
};

export const installOfficialConnector = async (
  stellaRoot: string,
  marketplaceKey: string,
  config: Record<string, string> = {},
) => {
  const safeKey = safeName(marketplaceKey);
  const official = getOfficialConnector(safeKey);
  if (!official?.servers?.length && !official?.apis?.length) {
    throw new Error(`No Stella-native connector configuration is available for ${marketplaceKey} yet.`);
  }
  const persistedConfig = getInterpolationConfig(config, official.configFields);
  const existing = await listConfiguredMcpServers(stellaRoot);
  const byId = new Map(existing.map((server) => [server.id, server]));
  for (const server of official.servers ?? []) {
    byId.set(server.id, interpolateConfig(server, persistedConfig));
  }
  const servers = [...byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  await saveConfiguredMcpServers(stellaRoot, servers);
  const existingApis = await listConfiguredApiConnectors(stellaRoot);
  const apiById = new Map(existingApis.map((api) => [api.id, api]));
  for (const api of official.apis ?? []) {
    apiById.set(api.id, interpolateConfig(api, persistedConfig));
  }
  const apis = [...apiById.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  await saveConfiguredApiConnectors(stellaRoot, apis);
  return {
    servers: (official.servers ?? []).map((server) => interpolateConfig(server, persistedConfig)),
    apis: (official.apis ?? []).map((api) => interpolateConfig(api, persistedConfig)),
  };
};

export const removeOfficialConnector = async (
  stellaRoot: string,
  marketplaceKey: string,
) => {
  const safeKey = safeName(marketplaceKey);
  const [servers, apis] = await Promise.all([
    listConfiguredMcpServers(stellaRoot),
    listConfiguredApiConnectors(stellaRoot),
  ]);
  await Promise.all([
    saveConfiguredMcpServers(
      stellaRoot,
      servers.filter((server) => server.source?.marketplaceKey !== safeKey),
    ),
    saveConfiguredApiConnectors(
      stellaRoot,
      apis.filter((api) => api.source?.marketplaceKey !== safeKey),
    ),
  ]);
};

export const listOfficialConnectorDefinitions = () =>
  OFFICIAL_CONNECTOR_DEFINITIONS;
