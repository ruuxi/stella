import { promises as fs } from "node:fs";
import path from "node:path";

import { clearConnectorDecline } from "./connect-preferences.js";
import { getConnectorStateRoot } from "./state.js";
import type { ConnectorToolInfo } from "./types.js";

/**
 * Authoritative Store entry returned by Stella's backend catalog.
 *
 * Composio is deliberately the sole connector provider. There is no bundled
 * catalog, local OAuth dispatcher, Google Workspace special case, or imported
 * MCP/API fallback behind this type.
 */
export type NativeConnectorCatalogEntry = {
  id: string;
  name: string;
  category: string;
  auth: readonly string[];
  catalogToolCount: number;
  availability: "ready";
  provider: "backend-composio";
  description: string;
  sourceUrl?: string;
  iconUrl?: string;
  connectable: true;
  backendConnector: {
    type: "composio";
    toolkit: string;
  };
};

export type NativeConnectorCatalogOverride =
  readonly NativeConnectorCatalogEntry[];

type NativeConnectorStateEntry = {
  enabled: boolean;
  enabledAt?: number;
  updatedAt: number;
  source?: "store";
  skillPath?: string;
};

type NativeConnectorStateFile = {
  version: 1;
  integrations: Record<string, NativeConnectorStateEntry>;
};

const STATE_FILE = "native-integrations.json";
const GENERATED_SKILL_MARKER = "<!-- stella-connect-native-skill -->";

/** The backend/cache catalog is the complete catalog; there is no local base. */
export const buildNativeConnectorCatalog = (
  catalog: NativeConnectorCatalogOverride = [],
): NativeConnectorCatalogEntry[] => [...catalog];

const statePath = (stellaAppDir: string) =>
  path.join(getConnectorStateRoot(stellaAppDir), STATE_FILE);

const skillsRoot = (stellaAppDir: string) => path.join(stellaAppDir, "skills");

const readState = async (
  stellaAppDir: string,
): Promise<NativeConnectorStateFile> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(statePath(stellaAppDir), "utf-8"),
    ) as NativeConnectorStateFile;
    if (parsed?.version === 1 && parsed.integrations) return parsed;
  } catch {
    // Empty state is valid.
  }
  return { version: 1, integrations: {} };
};

const writeState = async (
  stellaAppDir: string,
  state: NativeConnectorStateFile,
) => {
  const filePath = statePath(stellaAppDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
};

export const getNativeConnectorCatalogEntry = (
  id: string,
  catalog: NativeConnectorCatalogOverride,
) => catalog.find((entry) => entry.id === id);

export const backendIntegrationRunToolName = (id: string) =>
  `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_RUN_ACTION`;

export const getNativeConnectorTools = (
  entry: NativeConnectorCatalogEntry,
): ConnectorToolInfo[] => [
  {
    name: backendIntegrationRunToolName(entry.id),
    title: `Run ${entry.name} Action`,
    description: `Run a ${entry.name} action through Stella's connected account. Use catalog-actions to inspect supported action names and inputs.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          description: "Action slug from stella-connect catalog-actions.",
        },
        arguments: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
];

const connectorSetup = {
  connectable: true as const,
  oauthSetupStatus: "ready" as const,
  oauthSetupMessage: "Ready to connect.",
};

export const listNativeConnectors = async (
  stellaAppDir: string,
  catalog: NativeConnectorCatalogOverride,
) => {
  const state = await readState(stellaAppDir);
  return buildNativeConnectorCatalog(catalog).map((entry) => {
    const stored = state.integrations[entry.id];
    return {
      ...entry,
      ...connectorSetup,
      enabled: stored?.enabled === true,
      enabledAt: stored?.enabledAt,
      skillPath: stored?.skillPath,
      toolCount: getNativeConnectorTools(entry).length,
      actionCount: entry.catalogToolCount,
    };
  });
};

export const isNativeConnectorEnabled = async (
  stellaAppDir: string,
  id: string,
) => {
  const state = await readState(stellaAppDir);
  return state.integrations[id]?.enabled === true;
};

const writeNativeConnectorSkill = async (
  stellaAppDir: string,
  entry: NativeConnectorCatalogEntry,
) => {
  const skillDir = path.join(skillsRoot(stellaAppDir), entry.id);
  await fs.mkdir(skillDir, { recursive: true });
  // Older builds materialized the entire action catalog beside the skill.
  // Action metadata is now fetched from the authenticated backend on demand,
  // so remove any stale snapshot during enable/repair.
  await fs.rm(path.join(skillDir, "ACTIONS.md"), { force: true });
  const body = `---
name: ${entry.id}
description: Use the ${entry.name} integration through stella-connect.
---
${GENERATED_SKILL_MARKER}

# ${entry.name}

Use this skill for work that needs ${entry.name}. The integration must stay enabled in the Store.

Search supported actions and inspect their input schemas on demand:

\`\`\`bash
stella-connect tools ${entry.id} "<optional keywords>"
stella-connect catalog-actions ${entry.id} "<optional keywords>"
\`\`\`

Call an action:

\`\`\`bash
stella-connect call ${entry.id} <action-name> --json '{"key":"value"}'
\`\`\`

Action schemas are fetched through Stella's secure worker bridge and are not stored in this skill.
`;
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, body, "utf-8");
  return skillPath;
};

const removeGeneratedSkill = async (stellaAppDir: string, id: string) => {
  const skillDir = path.join(skillsRoot(stellaAppDir), id);
  const content = await fs
    .readFile(path.join(skillDir, "SKILL.md"), "utf-8")
    .catch(() => null);
  if (!content?.includes(GENERATED_SKILL_MARKER)) return;
  await fs.rm(skillDir, { recursive: true, force: true });
};

export const enableNativeConnector = async (
  stellaAppDir: string,
  id: string,
  source: "store",
  catalog: NativeConnectorCatalogOverride,
) => {
  const entry = getNativeConnectorCatalogEntry(id, catalog);
  if (!entry) throw new Error(`Unknown Store integration: ${id}`);
  const skillPath = await writeNativeConnectorSkill(stellaAppDir, entry);
  const state = await readState(stellaAppDir);
  const now = Date.now();
  state.integrations[id] = {
    enabled: true,
    enabledAt: state.integrations[id]?.enabledAt ?? now,
    updatedAt: now,
    source,
    skillPath,
  };
  await writeState(stellaAppDir, state);
  await clearConnectorDecline(stellaAppDir, id).catch(() => undefined);
  return {
    ...entry,
    ...connectorSetup,
    enabled: true,
    skillPath,
    toolCount: getNativeConnectorTools(entry).length,
    actionCount: entry.catalogToolCount,
  };
};

export const disableNativeConnector = async (
  stellaAppDir: string,
  id: string,
  catalog: NativeConnectorCatalogOverride,
) => {
  const entry = getNativeConnectorCatalogEntry(id, catalog);
  if (!entry) throw new Error(`Unknown Store integration: ${id}`);
  const state = await readState(stellaAppDir);
  const now = Date.now();
  state.integrations[id] = {
    ...(state.integrations[id] ?? { updatedAt: now }),
    enabled: false,
    updatedAt: now,
  };
  await writeState(stellaAppDir, state);
  await removeGeneratedSkill(stellaAppDir, id);
  return {
    ...entry,
    ...connectorSetup,
    enabled: false,
    toolCount: getNativeConnectorTools(entry).length,
    actionCount: entry.catalogToolCount,
  };
};
