import { promises as fs } from "node:fs";
import path from "node:path";

import type { ApiConnectorConfig, ConnectorCommandConfig } from "./types.js";

const readJson = async <T = unknown>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
};

export const getConnectorStateRoot = (stellaRoot: string) =>
  path.join(stellaRoot, "state", "connectors");

export const getConfiguredCommandsPath = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), "commands.json");

export const getConfiguredApiConnectorsPath = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), "api-connectors.json");

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

export const removeConfiguredConnector = async (
  stellaRoot: string,
  id: string,
): Promise<{ removedCommands: ConnectorCommandConfig[]; removedApis: ApiConnectorConfig[] }> => {
  const [commands, apis] = await Promise.all([
    listConfiguredConnectorCommands(stellaRoot),
    listConfiguredApiConnectors(stellaRoot),
  ]);
  const removedCommands = commands.filter((command) => command.id === id);
  const removedApis = apis.filter((api) => api.id === id);
  if (removedCommands.length === 0 && removedApis.length === 0) {
    return { removedCommands, removedApis };
  }
  await Promise.all([
    removedCommands.length > 0
      ? saveConfiguredConnectorCommands(
          stellaRoot,
          commands.filter((command) => command.id !== id),
        )
      : Promise.resolve(),
    removedApis.length > 0
      ? saveConfiguredApiConnectors(
          stellaRoot,
          apis.filter((api) => api.id !== id),
        )
      : Promise.resolve(),
  ]);
  return { removedCommands, removedApis };
};
