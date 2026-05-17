import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPOSIO_MANAGED_TOOLKITS,
  getComposioManagedToolkit,
  type ComposioManagedToolkit,
} from "./composio-catalog.js";
import { loadConnectorAccessToken } from "./oauth.js";
import {
  listConfiguredConnectorCommands,
  removeConfiguredConnector,
  saveConfiguredConnectorCommands,
} from "./state.js";
import type { ConnectorCommandConfig, ConnectorToolInfo } from "./types.js";

export const COMPOSIO_TOKEN_KEY = "composio.api_key";

export type ComposioConnectorSummary = ComposioManagedToolkit & {
  id: string;
  enabled: boolean;
  authStatus: "connected" | "not_logged_in";
  description: string;
};

export type ComposioConnectorInstallOptions = {
  toolkit: string;
  id?: string;
  displayName?: string;
  description?: string;
  tokenKey?: string;
  entityId?: string;
  tools?: ConnectorToolInfo[];
  probeDeferred?: boolean;
};

const normalizeConnectorId = (value: string) => {
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
    throw new Error(`Invalid connector id: ${value}`);
  }
  return id;
};

export const composioConnectorId = (toolkit: string) =>
  `composio-${normalizeConnectorId(toolkit)}`;

export const buildComposioConnectorCommand = ({
  id,
  toolkit,
  displayName,
  description,
  tokenKey = COMPOSIO_TOKEN_KEY,
  entityId,
}: {
  id: string;
  toolkit: string;
  displayName: string;
  description?: string;
  tokenKey?: string;
  entityId?: string;
}): ConnectorCommandConfig => {
  const nodeBin = process.env.STELLA_NODE_BIN || process.execPath;
  const adapterPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "composio-mcp.js",
  );
  return {
    id,
    displayName,
    description:
      description ?? `Use ${displayName} through Composio OAuth from Stella.`,
    transport: "stdio",
    command: nodeBin,
    args: [
      adapterPath,
      "--toolkit",
      toolkit,
      ...(entityId ? ["--entity-id", entityId] : []),
    ],
    env: {
      COMPOSIO_API_KEY: `\${${tokenKey}}`,
    },
    auth: {
      type: "api_key",
      tokenKey,
      envVar: "COMPOSIO_API_KEY",
    },
  };
};

export const writeConnectorSkill = async (
  stellaRoot: string,
  command: ConnectorCommandConfig,
  tools: ConnectorToolInfo[],
  { probeDeferred }: { probeDeferred: boolean } = { probeDeferred: false },
) => {
  const skillDir = path.join(stellaRoot, "state", "skills", command.id);
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

export const installComposioConnector = async (
  stellaRoot: string,
  options: ComposioConnectorInstallOptions,
) => {
  const toolkit = normalizeConnectorId(options.toolkit);
  const meta = getComposioManagedToolkit(toolkit);
  if (!meta) {
    throw new Error(`Unsupported Composio toolkit: ${options.toolkit}`);
  }
  const id = normalizeConnectorId(options.id ?? composioConnectorId(toolkit));
  const command = buildComposioConnectorCommand({
    id,
    toolkit,
    displayName: options.displayName ?? meta.name,
    description: options.description,
    tokenKey: options.tokenKey ?? COMPOSIO_TOKEN_KEY,
    entityId: options.entityId,
  });

  const existing = await listConfiguredConnectorCommands(stellaRoot);
  const next = new Map(existing.map((entry) => [entry.id, entry]));
  next.set(id, command);
  await saveConfiguredConnectorCommands(
    stellaRoot,
    [...next.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
  );

  const skillPath = await writeConnectorSkill(
    stellaRoot,
    command,
    options.tools ?? [],
    { probeDeferred: options.probeDeferred ?? false },
  );

  return { command, skillPath };
};

export const listComposioConnectorSummaries = async (
  stellaRoot: string,
): Promise<ComposioConnectorSummary[]> => {
  const [commands, hasComposioKey] = await Promise.all([
    listConfiguredConnectorCommands(stellaRoot),
    loadConnectorAccessToken(stellaRoot, COMPOSIO_TOKEN_KEY),
  ]);
  const enabledIds = new Set(commands.map((command) => command.id));

  return COMPOSIO_MANAGED_TOOLKITS.map((toolkit) => {
    const id = composioConnectorId(toolkit.slug);
    return {
      ...toolkit,
      id,
      enabled: enabledIds.has(id),
      authStatus: hasComposioKey ? "connected" : "not_logged_in",
      description: `Use ${toolkit.name} actions through Stella Connect.`,
    };
  });
};

export const disableComposioConnector = async (
  stellaRoot: string,
  toolkitOrId: string,
) => {
  const normalized = normalizeConnectorId(toolkitOrId);
  const id = normalized.startsWith("composio-")
    ? normalized
    : composioConnectorId(normalized);
  const removed = await removeConfiguredConnector(stellaRoot, id);
  await fs.rm(path.join(stellaRoot, "state", "skills", id), {
    recursive: true,
    force: true,
  });
  return { id, removed: removed.removedCommands.length > 0 };
};
