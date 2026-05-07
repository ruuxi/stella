import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getOfficialConnector, OFFICIAL_CONNECTOR_DEFINITIONS, type OfficialConnectorDefinition } from "./official-connectors.js";
import type { ApiConnectorConfig, ConnectorConfigField, ConnectorCommandConfig, StellaConnectorRecord } from "./types.js";

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

export const getConnectorStateRoot = (stellaRoot: string) =>
  path.join(stellaRoot, "state", "connectors");

export const getConfiguredCommandsPath = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), "commands.json");

export const getConfiguredApiConnectorsPath = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), "api-connectors.json");

const getCodexMarketplaceRoot = () =>
  process.env.STELLA_CONNECT_PLUGIN_MARKETPLACE_ROOT ??
  path.join(os.homedir(), ".codex", ".tmp", "plugins");

const listLocalMarketplacePlugins = async () => {
  const root = getCodexMarketplaceRoot();
  const marketplace = await readJson<{ plugins?: Array<Record<string, unknown>> }>(
    path.join(root, ".agents", "plugins", "marketplace.json"),
  );
  const plugins = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
  return { root, plugins };
};

const findLocalMarketplaceSourcePath = async (marketplaceKey: string) => {
  const { root, plugins } = await listLocalMarketplacePlugins();
  const plugin = plugins.find((entry) => entry.name === marketplaceKey);
  if (!plugin) return null;
  return path.resolve(root, String((plugin.source as { path?: unknown } | undefined)?.path ?? ""));
};

const listLocalMarketplaceEntries = async (): Promise<StellaConnectorRecord[]> => {
  const { root, plugins } = await listLocalMarketplacePlugins();
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
    const sourceConnectorConfig = await readJson<{ mcpServers?: Record<string, unknown> } | Record<string, unknown>>(
      path.join(sourcePath, ".mcp.json"),
    );

    const appIds = Object.values(appConfig?.apps ?? {})
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === "string");
    const commandConnectors = Object.keys(
      ((sourceConnectorConfig as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ??
        sourceConnectorConfig ??
        {}) as Record<string, unknown>,
    );
    if (appIds.length === 0 && commandConnectors.length === 0) continue;

    const interfaceData = manifest?.interface as Record<string, unknown> | undefined;
    const displayName =
      (typeof interfaceData?.displayName === "string" && interfaceData.displayName) ||
      (typeof manifest?.name === "string" && manifest.name) ||
      key;
    const official = getOfficialConnector(key);
    const executable = Boolean(official?.commands?.length || official?.apis?.length);
    const requiresCredential = official
      ? officialConnectorRequiresCredentialInput(official)
      : false;
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
      commandConnectors,
      officialSource: official?.officialSource,
      integrationPath: official?.integrationPath,
      auth: official?.auth,
      configFields: official?.configFields,
      executable,
      requiresCredential,
      status: official?.status ?? "local",
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
  const [entries, commands, apis] = await Promise.all([
    listLocalMarketplaceEntries(),
    listConfiguredConnectorCommands(stellaRoot),
    listConfiguredApiConnectors(stellaRoot),
  ]);
  const installedKeys = new Set(
    [...commands, ...apis]
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
      connector.commands?.some((server) => server.auth && server.auth.type !== "none"),
  );

const officialConnectorRequiresCredentialInput = (
  connector: OfficialConnectorDefinition,
) =>
  Boolean(
    connector.configFields?.length ||
      connector.apis?.some((api) => api.auth?.type === "api_key") ||
      connector.commands?.some((server) => server.auth?.type === "api_key"),
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

export const listConfiguredConnectorCommands = async (
  stellaRoot: string,
): Promise<ConnectorCommandConfig[]> => {
  const configured = await readJson<{ commands?: ConnectorCommandConfig[] }>(
    getConfiguredCommandsPath(stellaRoot),
  );
  return Array.isArray(configured?.commands) ? configured.commands : [];
};

export const saveConfiguredConnectorCommands = async (
  stellaRoot: string,
  commands: ConnectorCommandConfig[],
) => {
  const filePath = getConfiguredCommandsPath(stellaRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ commands }, null, 2)}\n`,
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
  if (!official?.commands?.length && !official?.apis?.length) {
    throw new Error(`No Stella-native connector configuration is available for ${marketplaceKey} yet.`);
  }
  const persistedConfig = getInterpolationConfig(config, official.configFields);
  const localSourcePath = await findLocalMarketplaceSourcePath(safeKey);
  const existing = await listConfiguredConnectorCommands(stellaRoot);
  const byId = new Map(existing.map((server) => [server.id, server]));
  for (const server of official.commands ?? []) {
    const interpolated = interpolateConfig(server, persistedConfig);
    byId.set(server.id, {
      ...interpolated,
      ...(interpolated.transport === "stdio" && !interpolated.cwd && localSourcePath
        ? { cwd: localSourcePath }
        : {}),
    });
  }
  const commands = [...byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  await saveConfiguredConnectorCommands(stellaRoot, commands);
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
    commands: (official.commands ?? []).map((server) => interpolateConfig(server, persistedConfig)),
    apis: (official.apis ?? []).map((api) => interpolateConfig(api, persistedConfig)),
  };
};

export const removeOfficialConnector = async (
  stellaRoot: string,
  marketplaceKey: string,
) => {
  const safeKey = safeName(marketplaceKey);
  const [commands, apis] = await Promise.all([
    listConfiguredConnectorCommands(stellaRoot),
    listConfiguredApiConnectors(stellaRoot),
  ]);
  const removedCommands = commands.filter((command) => command.source?.marketplaceKey === safeKey);
  const removedApis = apis.filter((api) => api.source?.marketplaceKey === safeKey);
  const official = getOfficialConnector(safeKey);
  const tokenKeys = [
    ...removedCommands.map((command) => command.auth?.tokenKey),
    ...removedApis.map((api) => api.auth?.tokenKey),
    ...(official?.commands ?? []).map((server) => server.auth?.tokenKey),
    ...(official?.apis ?? []).map((api) => api.auth?.tokenKey),
    ...(official?.configFields ?? []).map((field) => field.key),
  ];
  const { deleteConnectorAccessTokens } = await import("./oauth.js");
  await Promise.all([
    saveConfiguredConnectorCommands(
      stellaRoot,
      commands.filter((server) => server.source?.marketplaceKey !== safeKey),
    ),
    saveConfiguredApiConnectors(
      stellaRoot,
      apis.filter((api) => api.source?.marketplaceKey !== safeKey),
    ),
    deleteConnectorAccessTokens(stellaRoot, tokenKeys),
  ]);
  const { closeConnectorBridgeSessions } = await import("./connector-bridge.js");
  closeConnectorBridgeSessions(stellaRoot, removedCommands.map((command) => command.id));
};

export const listOfficialConnectorDefinitions = () =>
  OFFICIAL_CONNECTOR_DEFINITIONS;
