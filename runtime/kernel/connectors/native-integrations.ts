import { promises as fs } from "node:fs";
import path from "node:path";

import {
  GOOGLE_WORKSPACE_TOOL_ALLOWLIST,
  type GoogleWorkspaceToolName,
} from "../google-workspace/tool-allowlist.js";
import { GOOGLE_WORKSPACE_TOOL_METADATA } from "../google-workspace/google-workspace-tool-metadata.js";
import {
  getNativeProviderManifest,
  getNativeProviderTools,
  type NativeProviderAuth,
} from "./native-provider-actions.js";
import { getConnectorStateRoot } from "./state.js";
import type { ConnectorToolInfo } from "./types.js";

export type NativeConnectorAvailability = "ready" | "planned";

export type NativeConnectorCatalogEntry = {
  id: string;
  name: string;
  category: string;
  auth: readonly string[];
  catalogToolCount: number;
  availability: NativeConnectorAvailability;
  provider?: "google-workspace" | "native";
  nativeAuth?: NativeProviderAuth;
  toolPrefix?: string;
  description: string;
};

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

const managedCatalogSeed = [
  { id: "airtable", name: "Airtable", category: "productivity", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 25 },
  { id: "apaleo", name: "Apaleo", category: "scheduling & booking", auth: ["OAUTH2"], catalogToolCount: 29 },
  { id: "asana", name: "Asana", category: "project management", auth: ["OAUTH2"], catalogToolCount: 153 },
  { id: "attio", name: "Attio", category: "crm", auth: ["OAUTH2"], catalogToolCount: 108 },
  { id: "basecamp", name: "Basecamp", category: "project management", auth: ["OAUTH2"], catalogToolCount: 140 },
  { id: "bitbucket", name: "Bitbucket", category: "developer tools", auth: ["OAUTH2"], catalogToolCount: 107 },
  { id: "blackbaud", name: "Blackbaud", category: "fundraising", auth: ["OAUTH2"], catalogToolCount: 5 },
  { id: "boldsign", name: "Boldsign", category: "signatures", auth: ["OAUTH2"], catalogToolCount: 14 },
  { id: "box", name: "Box", category: "file management & storage", auth: ["OAUTH2"], catalogToolCount: 286 },
  { id: "cal", name: "Cal", category: "scheduling & booking", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 175 },
  { id: "calendly", name: "Calendly", category: "scheduling & booking", auth: ["OAUTH2"], catalogToolCount: 55 },
  { id: "canva", name: "Canva", category: "images & design", auth: ["OAUTH2"], catalogToolCount: 48 },
  { id: "capsule_crm", name: "Capsule CRM", category: "crm", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 109 },
  { id: "clickup", name: "ClickUp", category: "productivity", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 164 },
  { id: "confluence", name: "Confluence", category: "team collaboration", auth: ["OAUTH2", "S2S_OAUTH2", "API_KEY"], catalogToolCount: 62 },
  { id: "contentful", name: "Contentful", category: "developer tools", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 106 },
  { id: "convex", name: "Convex", category: "developer tools", auth: ["API_KEY", "BEARER_TOKEN"], catalogToolCount: 19 },
  { id: "crowdin", name: "Crowdin", category: "developer tools", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 231 },
  { id: "dart", name: "Dart", category: "project management", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 18 },
  { id: "dialpad", name: "Dialpad", category: "communication", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 192 },
  { id: "digital_ocean", name: "DigitalOcean", category: "developer tools", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 48 },
  { id: "dropbox", name: "Dropbox", category: "file management & storage", auth: ["OAUTH2"], catalogToolCount: 177 },
  { id: "dub", name: "Dub", category: "url shortener", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 17 },
  { id: "dynamics365", name: "Dynamics 365", category: "crm", auth: ["OAUTH2"], catalogToolCount: 16 },
  { id: "eventbrite", name: "Eventbrite", category: "event management", auth: ["OAUTH2"], catalogToolCount: 95 },
  { id: "excel", name: "Excel", category: "spreadsheets", auth: ["OAUTH2", "S2S_OAUTH2"], catalogToolCount: 54 },
  { id: "exist", name: "Exist", category: "analytics", auth: ["OAUTH2"], catalogToolCount: 12 },
  { id: "facebook", name: "Facebook", category: "social media accounts", auth: ["OAUTH2"], catalogToolCount: 43 },
  { id: "fathom", name: "Fathom", category: "ai meeting assistants", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 7 },
  { id: "figma", name: "Figma", category: "images & design", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 53 },
  { id: "freeagent", name: "Freeagent", category: "accounting", auth: ["OAUTH2"], catalogToolCount: 76 },
  { id: "freshbooks", name: "FreshBooks", category: "accounting", auth: ["OAUTH2"], catalogToolCount: 10 },
  { id: "github", name: "GitHub", category: "developer tools", auth: ["OAUTH2"], catalogToolCount: 867 },
  { id: "gitlab", name: "GitLab", category: "developer tools", auth: ["OAUTH2"], catalogToolCount: 58 },
  { id: "gmail", name: "Gmail", category: "email", auth: ["OAUTH2"], catalogToolCount: 63 },
  { id: "gong", name: "Gong", category: "analytics", auth: ["BASIC", "OAUTH2"], catalogToolCount: 58 },
  { id: "google_analytics", name: "Google Analytics", category: "analytics", auth: ["OAUTH2"], catalogToolCount: 69 },
  { id: "google_classroom", name: "Google Classroom", category: "education", auth: ["OAUTH2"], catalogToolCount: 62 },
  { id: "google_maps", name: "Google Maps", category: "developer tools", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 22 },
  { id: "google_search_console", name: "Google Search Console", category: "analytics", auth: ["OAUTH2"], catalogToolCount: 9 },
  { id: "googleads", name: "Google Ads", category: "ads & conversion", auth: ["OAUTH2"], catalogToolCount: 9 },
  { id: "googlebigquery", name: "Google BigQuery", category: "databases", auth: ["OAUTH2", "GOOGLE_SERVICE_ACCOUNT"], catalogToolCount: 63 },
  { id: "googlecalendar", name: "Google Calendar", category: "scheduling & booking", auth: ["OAUTH2"], catalogToolCount: 48 },
  { id: "googledocs", name: "Google Docs", category: "documents", auth: ["OAUTH2"], catalogToolCount: 35 },
  { id: "googledrive", name: "Google Drive", category: "file management & storage", auth: ["OAUTH2"], catalogToolCount: 89 },
  { id: "googlemeet", name: "Google Meet", category: "video conferencing", auth: ["OAUTH2"], catalogToolCount: 15 },
  { id: "googlephotos", name: "Google Photos", category: "images & design", auth: ["OAUTH2"], catalogToolCount: 14 },
  { id: "googlesheets", name: "Google Sheets", category: "spreadsheets", auth: ["OAUTH2"], catalogToolCount: 52 },
  { id: "googleslides", name: "Google Slides", category: "documents", auth: ["OAUTH2"], catalogToolCount: 8 },
  { id: "googlesuper", name: "Google Super", category: "file management & storage", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 442 },
  { id: "googletasks", name: "Google Tasks", category: "task management", auth: ["OAUTH2"], catalogToolCount: 18 },
  { id: "gorgias", name: "Gorgias", category: "crm", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 32 },
  { id: "gumroad", name: "Gumroad", category: "ecommerce", auth: ["OAUTH2"], catalogToolCount: 7 },
  { id: "harvest", name: "Harvest", category: "time tracking software", auth: ["OAUTH2"], catalogToolCount: 57 },
  { id: "hubspot", name: "HubSpot", category: "crm", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 233 },
  { id: "hugging_face", name: "Hugging Face", category: "artificial intelligence", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 135 },
  { id: "instagram", name: "Instagram", category: "social media accounts", auth: ["OAUTH2"], catalogToolCount: 36 },
  { id: "intercom", name: "Intercom", category: "customer support", auth: ["OAUTH2"], catalogToolCount: 133 },
  { id: "jira", name: "Jira", category: "project management", auth: ["OAUTH2", "S2S_OAUTH2", "API_KEY"], catalogToolCount: 97 },
  { id: "kit", name: "Kit", category: "marketing automation", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 42 },
  { id: "linear", name: "Linear", category: "project management", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 33 },
  { id: "linkedin", name: "LinkedIn", category: "social media accounts", auth: ["OAUTH2"], catalogToolCount: 22 },
  { id: "linkhut", name: "Linkhut", category: "bookmark managers", auth: ["OAUTH2"], catalogToolCount: 5 },
  { id: "mailchimp", name: "Mailchimp", category: "email newsletters", auth: ["OAUTH2"], catalogToolCount: 275 },
  { id: "microsoft_teams", name: "Microsoft Teams", category: "team chat", auth: ["OAUTH2", "S2S_OAUTH2"], catalogToolCount: 163 },
  { id: "miro", name: "Miro", category: "team collaboration", auth: ["OAUTH2"], catalogToolCount: 77 },
  { id: "monday", name: "Monday", category: "project management", auth: ["OAUTH2"], catalogToolCount: 125 },
  { id: "moneybird", name: "Moneybird", category: "accounting", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 21 },
  { id: "mural", name: "Mural", category: "team collaboration", auth: ["OAUTH2"], catalogToolCount: 22 },
  { id: "notion", name: "Notion", category: "notes", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 48 },
  { id: "omnisend", name: "Omnisend", category: "marketing automation", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 43 },
  { id: "one_drive", name: "OneDrive", category: "file management & storage", auth: ["OAUTH2", "S2S_OAUTH2"], catalogToolCount: 60 },
  { id: "outlook", name: "Outlook", category: "email", auth: ["OAUTH2", "S2S_OAUTH2"], catalogToolCount: 301 },
  { id: "pagerduty", name: "PagerDuty", category: "server monitoring", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 368 },
  { id: "prisma", name: "Prisma", category: "databases", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 22 },
  { id: "productboard", name: "Productboard", category: "product management", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 99 },
  { id: "pushbullet", name: "Pushbullet", category: "notifications", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 15 },
  { id: "quickbooks", name: "QuickBooks", category: "accounting", auth: ["OAUTH2"], catalogToolCount: 105 },
  { id: "reddit", name: "Reddit", category: "social media accounts", auth: ["OAUTH2"], catalogToolCount: 23 },
  { id: "reddit_ads", name: "Reddit Ads", category: "marketing", auth: ["OAUTH2"], catalogToolCount: 83 },
  { id: "roam", name: "Roam", category: "communication", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 39 },
  { id: "salesforce", name: "Salesforce", category: "crm", auth: ["OAUTH2", "S2S_OAUTH2"], catalogToolCount: 216 },
  { id: "sentry", name: "Sentry", category: "developer tools", auth: ["OAUTH2"], catalogToolCount: 207 },
  { id: "servicem8", name: "Servicem8", category: "scheduling & booking", auth: ["OAUTH2"], catalogToolCount: 28 },
  { id: "share_point", name: "SharePoint", category: "documents", auth: ["OAUTH2", "S2S_OAUTH2"], catalogToolCount: 89 },
  { id: "shippo", name: "Shippo", category: "ecommerce", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 95 },
  { id: "splitwise", name: "Splitwise", category: "accounting", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 27 },
  { id: "square", name: "Square", category: "payment processing", auth: ["OAUTH2"], catalogToolCount: 96 },
  { id: "stack_exchange", name: "Stack Exchange", category: "developer tools", auth: ["OAUTH2"], catalogToolCount: 121 },
  { id: "strava", name: "Strava", category: "fitness", auth: ["OAUTH2"], catalogToolCount: 33 },
  { id: "stripe", name: "Stripe", category: "payment processing", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 422 },
  { id: "supabase", name: "Supabase", category: "developer tools", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 121 },
  { id: "ticketmaster", name: "Ticketmaster", category: "event management", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 15 },
  { id: "ticktick", name: "Ticktick", category: "productivity", auth: ["OAUTH2"], catalogToolCount: 14 },
  { id: "timely", name: "Timely", category: "time tracking software", auth: ["OAUTH2"], catalogToolCount: 41 },
  { id: "todoist", name: "Todoist", category: "task management", auth: ["OAUTH2"], catalogToolCount: 84 },
  { id: "toneden", name: "Toneden", category: "social media marketing", auth: ["API_KEY", "OAUTH2"], catalogToolCount: 26 },
  { id: "trello", name: "Trello", category: "project management", auth: ["OAUTH1"], catalogToolCount: 329 },
  { id: "typeform", name: "Typeform", category: "forms & surveys", auth: ["OAUTH2"], catalogToolCount: 35 },
  { id: "wakatime", name: "WakaTime", category: "time tracking software", auth: ["OAUTH2"], catalogToolCount: 17 },
  { id: "webex", name: "Webex", category: "video conferencing", auth: ["OAUTH2"], catalogToolCount: 26 },
  { id: "whatsapp", name: "WhatsApp", category: "phone & sms", auth: ["OAUTH2", "API_KEY"], catalogToolCount: 17 },
  { id: "wrike", name: "Wrike", category: "project management", auth: ["OAUTH2"], catalogToolCount: 144 },
  { id: "yandex", name: "Yandex", category: "email", auth: ["OAUTH2"], catalogToolCount: 21 },
  { id: "ynab", name: "YNAB", category: "accounting", auth: ["OAUTH2"], catalogToolCount: 27 },
  { id: "youtube", name: "YouTube", category: "video & audio", auth: ["OAUTH2"], catalogToolCount: 50 },
  { id: "zendesk", name: "Zendesk", category: "crm", auth: ["OAUTH2"], catalogToolCount: 452 },
  { id: "zoho", name: "Zoho", category: "crm", auth: ["OAUTH2"], catalogToolCount: 14 },
  { id: "zoho_bigin", name: "Zoho Bigin", category: "crm", auth: ["OAUTH2"], catalogToolCount: 54 },
  { id: "zoho_books", name: "Zoho Books", category: "accounting", auth: ["OAUTH2"], catalogToolCount: 265 },
  { id: "zoho_desk", name: "Zoho Desk", category: "crm", auth: ["OAUTH2"], catalogToolCount: 23 },
  { id: "zoho_inventory", name: "Zoho Inventory", category: "accounting", auth: ["OAUTH2"], catalogToolCount: 58 },
  { id: "zoho_invoice", name: "Zoho Invoice", category: "proposal & invoice management", auth: ["OAUTH2"], catalogToolCount: 137 },
  { id: "zoho_mail", name: "Zoho Mail", category: "email", auth: ["OAUTH2"], catalogToolCount: 15 },
  { id: "zoom", name: "Zoom", category: "video conferencing", auth: ["OAUTH2"], catalogToolCount: 104 },
] as const;

const GOOGLE_NATIVE: Record<
  string,
  { toolPrefix: string; description: string }
> = {
  gmail: {
    toolPrefix: "gmail.",
    description: "Search, read, label, draft, and send Gmail messages.",
  },
  googlecalendar: {
    toolPrefix: "calendar.",
    description: "List calendars, create events, update events, and find free time.",
  },
  googledocs: {
    toolPrefix: "docs.",
    description: "Create, read, edit, comment on, and format Google Docs.",
  },
  googledrive: {
    toolPrefix: "drive.",
    description: "Search Drive, create folders, download files, and rename files.",
  },
};

export const NATIVE_CONNECTOR_CATALOG: NativeConnectorCatalogEntry[] =
  managedCatalogSeed.map((entry) => {
    const google = GOOGLE_NATIVE[entry.id];
    const native = getNativeProviderManifest(entry.id);
    return {
      ...entry,
      availability: google || native ? "ready" : "planned",
      ...(google ? { provider: "google-workspace" as const } : {}),
      ...(native ? { provider: "native" as const, nativeAuth: native.auth } : {}),
      ...(google ? { toolPrefix: google.toolPrefix } : {}),
      description:
        native?.description ??
        google?.description ??
        `${entry.name} is in Stella's native connector catalog and can be wired as a first-party integration.`,
    };
  });

const statePath = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), STATE_FILE);

const skillsRoot = (stellaRoot: string) => path.join(stellaRoot, "state", "skills");

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

export const getNativeConnectorCatalogEntry = (id: string) =>
  NATIVE_CONNECTOR_CATALOG.find((entry) => entry.id === id);

export const getNativeConnectorTools = (
  entry: NativeConnectorCatalogEntry,
): ConnectorToolInfo[] => {
  if (entry.provider === "native") return getNativeProviderTools(entry.id);
  if (entry.provider !== "google-workspace" || !entry.toolPrefix) return [];
  return GOOGLE_WORKSPACE_TOOL_ALLOWLIST.filter((toolName) =>
    toolName.startsWith(entry.toolPrefix!),
  ).map((toolName) => {
    const meta = GOOGLE_WORKSPACE_TOOL_METADATA[toolName as GoogleWorkspaceToolName];
    return {
      name: toolName,
      title: toolName,
      description: meta?.description,
      inputSchema: meta?.parameters,
    };
  });
};

export const listNativeConnectors = async (stellaRoot: string) => {
  const state = await readState(stellaRoot);
  return NATIVE_CONNECTOR_CATALOG.map((entry) => {
    const stored = state.integrations[entry.id];
    return {
      ...entry,
      enabled: stored?.enabled === true,
      enabledAt: stored?.enabledAt,
      skillPath: stored?.skillPath,
      toolCount: getNativeConnectorTools(entry).length,
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
  const actionLines = tools.length
    ? tools
        .map((tool) => {
          const description = tool.description ? ` - ${tool.description}` : "";
          return `- \`${tool.name}\`${description}`;
        })
        .join("\n")
    : "- Run `stella-connect tools <integration>` to inspect available actions.";
  const body = `---
name: ${entry.id}
description: Use the ${entry.name} integration through stella-connect.
---
${GENERATED_SKILL_MARKER}

# ${entry.name}

Use this skill for work that needs ${entry.name}. The integration must stay enabled in the Store; \`stella-connect\` refuses calls when it is disabled.

Inspect available actions:

\`\`\`bash
stella-connect tools ${entry.id}
\`\`\`

Call an action:

\`\`\`bash
stella-connect call ${entry.id} <action-name> --json '{"key":"value"}'
\`\`\`

## Actions

${actionLines}
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
) => {
  const entry = getNativeConnectorCatalogEntry(id);
  if (!entry) throw new Error(`Unknown native integration: ${id}`);
  if (entry.availability === "planned") {
    throw new Error(`${entry.name} is not wired as a native Stella connector yet.`);
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
    enabled: true,
    skillPath,
    toolCount: getNativeConnectorTools(entry).length,
  };
};

export const disableNativeConnector = async (
  stellaRoot: string,
  id: string,
) => {
  const entry = getNativeConnectorCatalogEntry(id);
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
    enabled: false,
    toolCount: getNativeConnectorTools(entry).length,
  };
};
