import { promises as fs } from "node:fs";
import path from "node:path";

import {
  GOOGLE_WORKSPACE_TOOL_ALLOWLIST,
  type GoogleWorkspaceToolName,
} from "../google-workspace/tool-allowlist.js";
import { GOOGLE_WORKSPACE_TOOL_METADATA } from "../google-workspace/google-workspace-tool-metadata.js";
import {
  getNativeOAuthProviderConfig,
  getNativeOAuthProviderSetupGroup,
  hasNativeOAuthProviderClientIdOverride,
  hasNativeOAuthProviderTemplate,
  isNativeOAuthProviderConfigReady,
  type NativeOAuthProviderConfig,
  type NativeOAuthProviderConfigOptions,
} from "./native-oauth-provider-config.js";
import { OAUTH_PROVIDER_CATALOG } from "./oauth-provider-catalog.js";
import { getConnectorStateRoot } from "./state.js";
import type { ConnectorToolInfo } from "./types.js";
import type { OAuthCatalogTool } from "./oauth-provider-catalog.js";

export type NativeConnectorAvailability = "ready";
export type NativeConnectorOAuthSetupStatus =
  | "ready"
  | "missing_oauth_app"
  | "missing_backend_exchange"
  | "missing_callback_bridge";

export type NativeConnectorCatalogEntry = {
  id: string;
  name: string;
  category: string;
  auth: readonly string[];
  catalogToolCount: number;
  availability: NativeConnectorAvailability;
  provider: "google-workspace" | "oauth-catalog" | "backend-composio";
  toolPrefix?: string;
  description: string;
  sourceUrl?: string;
  iconUrl?: string;
  connectable: boolean;
  backendConnector?: {
    type: "composio";
    toolkit: string;
  };
  oauthConfig?: NativeOAuthProviderConfig;
  oauthSetupGroup?: {
    id: string;
    name: string;
  };
  oauthProviderTemplate?: boolean;
};

export type NativeConnectorCatalogAction = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type NativeConnectorCatalogOverride = readonly NativeConnectorCatalogEntry[];

type NativeConnectorStateEntry = {
  enabled: boolean;
  enabledAt?: number;
  updatedAt: number;
  source?: "store" | "cli";
  skillPath?: string;
};

type NativeConnectorStateFile = {
  version: 1;
  integrations: Record<string, NativeConnectorStateEntry>;
};

const STATE_FILE = "native-integrations.json";
const GENERATED_SKILL_MARKER = "<!-- stella-connect-native-skill -->";
const EXISTING_GOOGLE_INTEGRATION_IDS = new Set([
  "gmail",
  "google_admin",
  "google_analytics",
  "google_classroom",
  "google_maps",
  "google_search_console",
  "googleads",
  "googlebigquery",
  "googlecalendar",
  "googledocs",
  "googledrive",
  "googlemeet",
  "googlephotos",
  "googlesheets",
  "googleslides",
  "googlesuper",
  "googletasks",
]);

const isExistingGoogleIntegration = (id: string) =>
  EXISTING_GOOGLE_INTEGRATION_IDS.has(id) || id.startsWith("google");

const BACKEND_OWNED_COMMUNICATION_INTEGRATION_IDS = new Set([
  "discord",
  "discordbot",
  "microsoft_teams",
  "slack",
  "slackbot",
  "whatsapp",
]);

const isBackendOwnedCommunicationIntegration = (id: string) =>
  BACKEND_OWNED_COMMUNICATION_INTEGRATION_IDS.has(id);

const API_KEY_ONLY_INTEGRATION_IDS = new Set([
  "borneo",
  "clockify",
  "epic_games",
  "insighto_ai",
  "lodgify",
  "matterport",
  "parma",
  "pinecone",
  "recruitee",
  "scheduleonce",
  "sendloop",
  "tally",
  "ticketmaster",
  "trello",
  "wix",
  "zoominfo",
]);

const isApiKeyOnlyIntegration = (id: string) =>
  API_KEY_ONLY_INTEGRATION_IDS.has(id);

const GOOGLE_WORKSPACE_CONNECTOR_CATALOG: NativeConnectorCatalogEntry[] = [
  {
    id: "gmail",
    name: "Gmail",
    category: "email",
    auth: ["OAUTH2"],
    catalogToolCount: 63,
    availability: "ready",
    provider: "google-workspace",
    toolPrefix: "gmail.",
    connectable: true,
    description: "Search, read, label, draft, and send Gmail messages.",
  },
  {
    id: "googlecalendar",
    name: "Google Calendar",
    category: "scheduling & booking",
    auth: ["OAUTH2"],
    catalogToolCount: 48,
    availability: "ready",
    provider: "google-workspace",
    toolPrefix: "calendar.",
    connectable: true,
    description:
      "List calendars, create events, update events, and find free time.",
  },
  {
    id: "googledocs",
    name: "Google Docs",
    category: "documents",
    auth: ["OAUTH2"],
    catalogToolCount: 35,
    availability: "ready",
    provider: "google-workspace",
    toolPrefix: "docs.",
    connectable: true,
    description: "Create, read, edit, comment on, and format Google Docs.",
  },
  {
    id: "googledrive",
    name: "Google Drive",
    category: "file management & storage",
    auth: ["OAUTH2"],
    catalogToolCount: 89,
    availability: "ready",
    provider: "google-workspace",
    toolPrefix: "drive.",
    connectable: true,
    description:
      "Search Drive, create folders, download files, and rename files.",
  },
];

const FALLBACK_OAUTH_CONNECTOR_CATALOG: NativeConnectorCatalogEntry[] =
  OAUTH_PROVIDER_CATALOG.filter(
    (entry) =>
      !isExistingGoogleIntegration(entry.id) &&
      !isBackendOwnedCommunicationIntegration(entry.id) &&
      !isApiKeyOnlyIntegration(entry.id),
  ).map((entry) => ({
    id: entry.id,
    name: entry.name,
    category: entry.category,
    auth: entry.auth,
    catalogToolCount: entry.catalogToolCount,
    availability: "ready" as const,
    provider: "oauth-catalog" as const,
    description: entry.description,
    sourceUrl: entry.sourceUrl,
    connectable: false,
  }));

export const NATIVE_CONNECTOR_CATALOG: NativeConnectorCatalogEntry[] = [
  ...GOOGLE_WORKSPACE_CONNECTOR_CATALOG,
  ...FALLBACK_OAUTH_CONNECTOR_CATALOG,
];

export const buildNativeConnectorCatalog = (
  serverCatalog?: NativeConnectorCatalogOverride,
): NativeConnectorCatalogEntry[] => {
  if (serverCatalog === undefined) return NATIVE_CONNECTOR_CATALOG;
  const byId = new Map<string, NativeConnectorCatalogEntry>();
  for (const entry of GOOGLE_WORKSPACE_CONNECTOR_CATALOG) byId.set(entry.id, entry);
  for (const entry of serverCatalog) byId.set(entry.id, entry);
  return Array.from(byId.values());
};

const statePath = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), STATE_FILE);

const skillsRoot = (stellaRoot: string) =>
  path.join(stellaRoot, "state", "skills");

const readState = async (
  stellaRoot: string,
): Promise<NativeConnectorStateFile> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(statePath(stellaRoot), "utf-8"),
    ) as NativeConnectorStateFile;
    if (parsed?.version === 1 && parsed.integrations) return parsed;
  } catch {
    // Empty state is valid.
  }
  return { version: 1, integrations: {} };
};

const writeState = async (
  stellaRoot: string,
  state: NativeConnectorStateFile,
) => {
  const filePath = statePath(stellaRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
};

export const getNativeConnectorCatalogEntry = (
  id: string,
  catalog: NativeConnectorCatalogOverride = NATIVE_CONNECTOR_CATALOG,
) => catalog.find((entry) => entry.id === id);

export const getNativeConnectorOAuthConfig = (
  entry: NativeConnectorCatalogEntry,
) => entry.oauthConfig ?? getNativeOAuthProviderConfig(entry.id);

const getOAuthCatalogProvider = (id: string) =>
  OAUTH_PROVIDER_CATALOG.find((entry) => entry.id === id);

const normalizeOAuthCatalogToolName = (tool: OAuthCatalogTool) => {
  const raw = tool.title?.trim() || tool.name.trim();
  return raw || "Unnamed action";
};

const schemaTypeLabel = (schema: unknown): string => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";
  const record = schema as Record<string, unknown>;
  if (typeof record.type === "string") return record.type;
  if (Array.isArray(record.type)) {
    return record.type.filter((entry) => typeof entry === "string").join(" | ");
  }
  if (Array.isArray(record.anyOf)) return "one of";
  if (Array.isArray(record.oneOf)) return "one of";
  return "";
};

const schemaDescription = (schema: unknown): string => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";
  const description = (schema as Record<string, unknown>).description;
  if (typeof description !== "string") return "";
  return description.replace(/\s+/gu, " ").trim();
};

const summarizeInputSchema = (schema?: Record<string, unknown>) => {
  if (!schema) return "";
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const propertyNames = Object.keys(properties);
  if (propertyNames.length === 0) return "";

  const describeProperty = (name: string) => {
    const property = properties[name];
    const type = schemaTypeLabel(property);
    const description = schemaDescription(property);
    const suffix = [
      type ? ` (${type})` : "",
      description ? `: ${description}` : "",
    ].join("");
    return `\`${name}\`${suffix}`;
  };
  const requiredSet = new Set(required);
  const requiredProperties = propertyNames
    .filter((name) => requiredSet.has(name))
    .slice(0, 8);
  const optionalProperties = propertyNames
    .filter((name) => !requiredSet.has(name))
    .slice(0, Math.max(0, 8 - requiredProperties.length));
  const parts: string[] = [];
  if (requiredProperties.length > 0) {
    parts.push(`Required: ${requiredProperties.map(describeProperty).join("; ")}`);
  }
  if (optionalProperties.length > 0) {
    parts.push(`Optional: ${optionalProperties.map(describeProperty).join("; ")}`);
  }
  const omitted = propertyNames.length - requiredProperties.length - optionalProperties.length;
  return parts.length > 0
    ? ` ${parts.join(". ")}${omitted > 0 ? `. Plus ${omitted} more.` : "."}`
    : "";
};

export const getNativeConnectorCatalogActions = (
  entry: NativeConnectorCatalogEntry,
): NativeConnectorCatalogAction[] => {
  if (entry.provider === "oauth-catalog" || entry.provider === "backend-composio") {
    if (entry.oauthConfig) return [];
    return (getOAuthCatalogProvider(entry.id)?.tools ?? []).map((tool) => ({
      name: normalizeOAuthCatalogToolName(tool),
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));
  }
  if (!entry.toolPrefix) return [];
  return GOOGLE_WORKSPACE_TOOL_ALLOWLIST.filter((toolName) =>
    toolName.startsWith(entry.toolPrefix!),
  ).map((toolName) => {
    const meta =
      GOOGLE_WORKSPACE_TOOL_METADATA[toolName as GoogleWorkspaceToolName];
    return {
      name: toolName,
      title: toolName,
      ...(meta?.description ? { description: meta.description } : {}),
    };
  });
};

export const nativeOAuthApiRequestToolName = (id: string) =>
  `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_REQUEST`;

export const backendIntegrationRunToolName = (id: string) =>
  `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_RUN_ACTION`;

export const getNativeConnectorTools = (
  entry: NativeConnectorCatalogEntry,
): ConnectorToolInfo[] => {
  if (entry.provider === "backend-composio") {
    return [
      {
        name: backendIntegrationRunToolName(entry.id),
        title: `Run ${entry.name} Action`,
        description: `Run a ${entry.name} action through Stella's connected integration account. Use catalog-actions to inspect supported action names and inputs.`,
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
  }
  if (entry.provider === "oauth-catalog") {
    const config = getNativeConnectorOAuthConfig(entry);
    if (!config?.resourceUrl) return [];
    const apiRequest: ConnectorToolInfo = {
      name: nativeOAuthApiRequestToolName(entry.id),
      title: `${entry.name} API Request`,
      description: `Call the ${entry.name} API with the connected OAuth account. Provide a path, method, optional query, and optional JSON body.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "API path beginning with /.",
          },
          method: {
            type: "string",
            description: "HTTP method. Defaults to GET.",
          },
          query: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
              ],
            },
          },
          body: {
            type: "object",
            additionalProperties: true,
          },
          headers: {
            type: "object",
            description:
              "Optional provider-specific headers. Stella always injects the OAuth Authorization header.",
            additionalProperties: {
              type: "string",
            },
          },
        },
      },
    };
    if (entry.id === "linear") {
      return [
        {
          name: "LINEAR_RUN_QUERY_OR_MUTATION",
          title: "Run Linear Query Or Mutation",
          description:
            "Run a Linear GraphQL query or mutation with the connected account.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
              query: {
                type: "string",
                description: "GraphQL query or mutation.",
              },
              variables: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
        apiRequest,
      ];
    }
    return [apiRequest];
  }
  if (!entry.toolPrefix) return [];
  return GOOGLE_WORKSPACE_TOOL_ALLOWLIST.filter((toolName) =>
    toolName.startsWith(entry.toolPrefix!),
  ).map((toolName) => {
    const meta =
      GOOGLE_WORKSPACE_TOOL_METADATA[toolName as GoogleWorkspaceToolName];
    return {
      name: toolName,
      title: toolName,
      description: meta?.description,
      inputSchema: meta?.parameters,
    };
  });
};

const getNativeConnectorOAuthSetup = (
  entry: NativeConnectorCatalogEntry,
  options: NativeOAuthProviderConfigOptions = {},
) => {
  if (entry.provider === "backend-composio") {
    return {
      connectable: true,
      oauthSetupStatus: "ready" as const,
      oauthSetupMessage: "Ready to connect.",
    };
  }
  if (entry.connectable) {
    return {
      connectable: true,
      oauthSetupStatus: "ready" as const,
      oauthSetupMessage: "Ready to connect.",
    };
  }
  const config = getNativeConnectorOAuthConfig(entry);
  const setupGroup = getNativeOAuthProviderSetupGroup(entry.id);
  const hasProviderTemplate = hasNativeOAuthProviderTemplate(entry.id);
  if (!config) {
    return {
      connectable: false,
      oauthSetupStatus: "missing_oauth_app" as const,
      oauthSetupMessage: setupGroup
        ? `Stella has recovered this integration. Finish one ${setupGroup.name} connection setup to enable this and related integrations.`
        : hasProviderTemplate
          ? "Stella has the OAuth integration shape for this provider. Register the Stella OAuth app before it can be added."
          : "Stella has recovered this integration. Finish its provider setup before it can be added.",
      ...(setupGroup ? { oauthSetupGroup: setupGroup } : {}),
      ...(hasProviderTemplate ? { oauthProviderTemplate: true } : {}),
    };
  }
  if (isNativeOAuthProviderConfigReady(entry.id, config, options)) {
    return {
      connectable: true,
      oauthSetupStatus: "ready" as const,
      oauthSetupMessage: "Ready to connect.",
      ...(setupGroup ? { oauthSetupGroup: setupGroup } : {}),
    };
  }
  const tokenExchangeProvider = (config.tokenExchange?.provider ?? entry.id)
    .trim()
    .toLowerCase();
  const hasExplicitOAuthApp =
    hasNativeOAuthProviderClientIdOverride(entry.id) ||
    hasNativeOAuthProviderClientIdOverride(tokenExchangeProvider);
  if (config.tokenExchange?.type === "backend") {
    if (!hasExplicitOAuthApp) {
      return {
        connectable: false,
        oauthSetupStatus: "missing_oauth_app" as const,
        oauthSetupMessage: setupGroup
          ? `Stella has recovered this integration. Finish one ${setupGroup.name} connection setup to enable this and related integrations.`
          : "Stella has the OAuth integration shape for this provider. Register the Stella OAuth app before it can be added.",
        ...(setupGroup ? { oauthSetupGroup: setupGroup } : {}),
        oauthProviderTemplate: true,
      };
    }
    return {
      connectable: false,
      oauthSetupStatus: "missing_backend_exchange" as const,
      oauthSetupMessage: setupGroup
        ? `Stella has a ${setupGroup.name} connection setup for this integration family, but the secure server connection is not ready yet.`
        : "Stella has this provider setup, but the secure server connection is not ready yet.",
      ...(setupGroup ? { oauthSetupGroup: setupGroup } : {}),
    };
  }
  if (
    config.flow === "authorization_code" &&
    config.callbackMode === "external"
  ) {
    return {
      connectable: false,
      oauthSetupStatus: "missing_callback_bridge" as const,
      oauthSetupMessage:
        "Stella has this provider setup, but the browser return link is not ready yet.",
      ...(setupGroup ? { oauthSetupGroup: setupGroup } : {}),
    };
  }
  return {
    connectable: false,
    oauthSetupStatus: "missing_oauth_app" as const,
    oauthSetupMessage: setupGroup
      ? `Stella has recovered this integration. Finish one ${setupGroup.name} connection setup to enable this and related integrations.`
      : "Stella has recovered this integration. Finish its provider setup before it can be added.",
    ...(setupGroup ? { oauthSetupGroup: setupGroup } : {}),
  };
};

export const listNativeConnectors = async (
  stellaRoot: string,
  options: NativeOAuthProviderConfigOptions = {},
  catalogOverride?: NativeConnectorCatalogOverride,
) => {
  const state = await readState(stellaRoot);
  return buildNativeConnectorCatalog(catalogOverride).map((entry) => {
    const stored = state.integrations[entry.id];
    const setup = getNativeConnectorOAuthSetup(entry, options);
    return {
      ...entry,
      ...setup,
      enabled: stored?.enabled === true,
      enabledAt: stored?.enabledAt,
      skillPath: stored?.skillPath,
      toolCount: getNativeConnectorTools(entry).length,
      actionCount:
        entry.provider === "oauth-catalog" || entry.provider === "backend-composio"
          ? entry.catalogToolCount
          : getNativeConnectorCatalogActions(entry).length,
    };
  });
};

export const isNativeConnectorEnabled = async (
  stellaRoot: string,
  id: string,
) => {
  const state = await readState(stellaRoot);
  return state.integrations[id]?.enabled === true;
};

const writeNativeConnectorSkill = async (
  stellaRoot: string,
  entry: NativeConnectorCatalogEntry,
) => {
  const skillDir = path.join(skillsRoot(stellaRoot), entry.id);
  await fs.mkdir(skillDir, { recursive: true });
  const tools = getNativeConnectorTools(entry);
  const catalogActions = getNativeConnectorCatalogActions(entry);
  const toolLines = tools.length
    ? tools
        .map((tool) => {
          const description = tool.description ? ` - ${tool.description}` : "";
          return `- \`${tool.name}\`${description}`;
        })
        .join("\n")
    : "- No executable tools are available yet.";
  const catalogActionLines =
    catalogActions.length > 0
      ? catalogActions
          .map((action) => {
            const description = action.description
              ? ` - ${action.description}`
              : "";
            return `- ${action.name}${description}${summarizeInputSchema(action.inputSchema)}`;
          })
          .join("\n")
      : "- No recovered catalog actions were available for this provider.";
  const catalogActionsPath = path.join(skillDir, "ACTIONS.md");
  if (entry.provider === "oauth-catalog" || entry.provider === "backend-composio") {
    await fs.writeFile(
      catalogActionsPath,
      entry.provider === "backend-composio"
        ? `# ${entry.name} Actions\n\nThese are Stella action references for ${entry.name}. Stella owns the CLI and backend contract; the current backend provider may use Composio behind the scenes. Call actions with \`stella-connect call ${entry.id} <action-name> --json '{}'\` or \`${backendIntegrationRunToolName(entry.id)}\`.\n\n${catalogActionLines}\n`
        : `# ${entry.name} Catalog Actions\n\nThese are recovered OAuth action references from the Composio toolkit catalog. Use them to choose the right ${entry.name} API endpoint and arguments. Stella executes this integration through \`stella-connect call ${entry.id} /path\` and \`${nativeOAuthApiRequestToolName(entry.id)}\` until a provider-specific typed dispatcher exists.\n\n${catalogActionLines}\n`,
      "utf-8",
    );
  }
  const body = `---
name: ${entry.id}
description: Use the ${entry.name} integration through stella-connect.
---
${GENERATED_SKILL_MARKER}

# ${entry.name}

Use this skill for work that needs ${entry.name}. The integration must stay enabled in the Store; \`stella-connect\` refuses calls when it is disabled.

Inspect executable tools:

\`\`\`bash
stella-connect tools ${entry.id}
\`\`\`

${
  entry.provider === "backend-composio"
    ? `
Call an action:

\`\`\`bash
stella-connect call ${entry.id} <action-name> --json '{"key":"value"}'
\`\`\`

This provider has ${entry.catalogToolCount} Stella catalog actions. Use \`ACTIONS.md\` in this skill folder as the action reference. The backend owns the provider boundary, so the CLI shape stays the same if Stella later moves this integration to native OAuth.

Inspect the catalog actions:

\`\`\`bash
stella-connect catalog-actions ${entry.id}
\`\`\`
`
    : entry.provider === "oauth-catalog"
    ? `
For native OAuth API calls, pass an API path instead of an action name:

\`\`\`bash
stella-connect call ${entry.id} /path --method GET --query-json '{}'
\`\`\`

This provider has ${entry.catalogToolCount} recovered OAuth catalog actions. Use \`ACTIONS.md\` in this skill folder as the action reference, then call the provider API with the connected OAuth account.

Inspect the recovered catalog actions:

\`\`\`bash
stella-connect catalog-actions ${entry.id}
\`\`\`
`
    : `
Call an action:

\`\`\`bash
stella-connect call ${entry.id} <action-name> --json '{"key":"value"}'
\`\`\`
`
}

## Executable Tools

${toolLines}
`;
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, body, "utf-8");
  return skillPath;
};

const removeGeneratedSkill = async (stellaRoot: string, id: string) => {
  const skillDir = path.join(skillsRoot(stellaRoot), id);
  const skillPath = path.join(skillDir, "SKILL.md");
  const content = await fs.readFile(skillPath, "utf-8").catch(() => null);
  if (!content?.includes(GENERATED_SKILL_MARKER)) return;
  await fs.rm(skillDir, { recursive: true, force: true });
};

export const enableNativeConnector = async (
  stellaRoot: string,
  id: string,
  source: "store" | "cli" = "cli",
  options: NativeOAuthProviderConfigOptions = {},
  catalogOverride?: NativeConnectorCatalogOverride,
) => {
  const catalog = buildNativeConnectorCatalog(catalogOverride);
  const entry = getNativeConnectorCatalogEntry(id, catalog);
  if (!entry) throw new Error(`Unknown native integration: ${id}`);
  const setup = getNativeConnectorOAuthSetup(entry, options);
  if (!setup.connectable) {
    const config = getNativeConnectorOAuthConfig(entry);
    if (config?.tokenExchange?.type === "backend") {
      const tokenExchangeProvider = (config.tokenExchange.provider ?? entry.id)
        .trim()
        .toLowerCase();
      const hasExplicitOAuthApp =
        hasNativeOAuthProviderClientIdOverride(entry.id) ||
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
      config?.flow === "authorization_code" &&
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
  const skillPath = await writeNativeConnectorSkill(stellaRoot, entry);
  const state = await readState(stellaRoot);
  const now = Date.now();
  state.integrations[id] = {
    enabled: true,
    enabledAt: state.integrations[id]?.enabledAt ?? now,
    updatedAt: now,
    source,
    skillPath,
  };
  await writeState(stellaRoot, state);
  // `toolCount` mirrors what `listNativeConnectors` returns so the
  // website can drop the updated entry straight into its local state
  // without re-listing. Omitting it would briefly render "undefined
  // actions" on the just-enabled card until the next list refresh.
  return {
    ...entry,
    ...setup,
    enabled: true,
    skillPath,
    toolCount: getNativeConnectorTools(entry).length,
    actionCount:
      entry.provider === "oauth-catalog"
        ? entry.catalogToolCount
        : entry.provider === "backend-composio"
          ? entry.catalogToolCount
          : getNativeConnectorCatalogActions(entry).length,
  };
};

export const disableNativeConnector = async (
  stellaRoot: string,
  id: string,
  options: NativeOAuthProviderConfigOptions = {},
  catalogOverride?: NativeConnectorCatalogOverride,
) => {
  const catalog = buildNativeConnectorCatalog(catalogOverride);
  const entry = getNativeConnectorCatalogEntry(id, catalog);
  if (!entry) throw new Error(`Unknown native integration: ${id}`);
  const state = await readState(stellaRoot);
  const now = Date.now();
  state.integrations[id] = {
    ...(state.integrations[id] ?? { updatedAt: now }),
    enabled: false,
    updatedAt: now,
  };
  await writeState(stellaRoot, state);
  await removeGeneratedSkill(stellaRoot, id);
  return {
    ...entry,
    ...getNativeConnectorOAuthSetup(entry, options),
    enabled: false,
    toolCount: getNativeConnectorTools(entry).length,
    actionCount:
      entry.provider === "oauth-catalog"
        ? entry.catalogToolCount
        : entry.provider === "backend-composio"
          ? entry.catalogToolCount
          : getNativeConnectorCatalogActions(entry).length,
  };
};
