#!/usr/bin/env node
import { OAUTH_PROVIDER_CATALOG } from "../kernel/connectors/oauth-provider-catalog.ts";

const siteUrl = (
  process.env.STELLA_CONVEX_SITE_URL ||
  process.env.CONVEX_SITE_URL ||
  ""
).replace(/\/+$/u, "");
const adminToken =
  process.env.STELLA_ADMIN_API_SECRET ||
  process.env.STELLA_ADMIN_TOKEN ||
  process.env.STELLA_ADMIN_SECRET ||
  process.env.ADMIN_TOKEN ||
  "";
const composioApiKey = process.env.COMPOSIO_API_KEY || "";
const apply = process.argv.includes("--apply");

const GOOGLE_TOOLKIT_IDS = [
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
];

const GOOGLE_TOOLKIT_FALLBACKS = [
  {
    id: "gmail",
    name: "Gmail",
    category: "email",
    catalogToolCount: 61,
    description:
      "Gmail is Google's email service, featuring spam protection, search functions, and integration with other Google Workspace apps.",
  },
  {
    id: "googlecalendar",
    name: "Google Calendar",
    category: "scheduling & booking",
    catalogToolCount: 44,
    description:
      "Google Calendar provides scheduling, event reminders, and integration with email and other apps.",
  },
  {
    id: "googledocs",
    name: "Google Docs",
    category: "documents",
    catalogToolCount: 33,
    description:
      "Google Docs is a cloud-based word processor with real-time collaboration and version history.",
  },
  {
    id: "googledrive",
    name: "Google Drive",
    category: "file management & storage",
    catalogToolCount: 76,
    description:
      "Google Drive is a cloud storage solution for uploading, sharing, and collaborating on files.",
  },
];

const BACKEND_OWNED = new Set([
  "discord",
  "discordbot",
  "microsoft_teams",
  "slack",
  "slackbot",
  "whatsapp",
]);

const API_KEY_ONLY = new Set([
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

const shouldPublish = (entry) =>
  !BACKEND_OWNED.has(entry.id) &&
  !API_KEY_ONLY.has(entry.id);

const toRow = (entry) => ({
  id: entry.id,
  name: entry.name,
  provider: "composio",
  category: entry.category,
  auth: ["OAUTH2"],
  catalogToolCount: entry.catalogToolCount,
  description: entry.description,
  sourceUrl: entry.sourceUrl,
  iconUrl: `https://logos.composio.dev/api/${entry.id}`,
  connector: {
    type: "composio",
    toolkit: entry.id,
    provider: "composio",
  },
  enabled: true,
  usagePolicy: "ready",
});

const fetchGoogleToolkitRows = async () => {
  if (!composioApiKey) return GOOGLE_TOOLKIT_FALLBACKS.map(toRow);
  const rows = [];
  for (const id of GOOGLE_TOOLKIT_IDS) {
    const response = await fetch(
      `https://backend.composio.dev/api/v3.1/toolkits/${id}`,
      {
        headers: {
          accept: "application/json",
          "x-api-key": composioApiKey,
        },
      },
    );
    if (!response.ok) continue;
    const payload = await response.json();
    const name = typeof payload.name === "string" ? payload.name : id;
    const category =
      typeof payload.meta?.categories?.[0]?.name === "string"
        ? payload.meta.categories[0].name.toLowerCase()
        : "integrations";
    const catalogToolCount =
      typeof payload.meta?.tools_count === "number"
        ? payload.meta.tools_count
        : 0;
    const description =
      typeof payload.meta?.description === "string"
        ? payload.meta.description
        : `Connect ${name} to Stella.`;
    rows.push(
      toRow({
        id,
        name,
        category,
        auth: ["OAUTH2"],
        catalogToolCount,
        description,
        sourceUrl: `https://composio.dev/toolkits/${id}`,
      }),
    );
  }
  if (rows.length > 0) return rows;
  return GOOGLE_TOOLKIT_FALLBACKS.map(toRow);
};

const rowsById = new Map(
  OAUTH_PROVIDER_CATALOG.filter(shouldPublish).map((entry) => [
    entry.id,
    toRow(entry),
  ]),
);
for (const row of await fetchGoogleToolkitRows()) rowsById.set(row.id, row);
const rows = [...rowsById.values()];

if (!apply) {
  process.stdout.write(
    `${JSON.stringify(
      {
        count: rows.length,
        first: rows.slice(0, 5).map((row) => row.id),
        hint:
          "Set STELLA_CONVEX_SITE_URL and STELLA_ADMIN_TOKEN, then pass --apply to publish.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (!siteUrl || !adminToken) {
  process.stderr.write(
    "Missing STELLA_CONVEX_SITE_URL/CONVEX_SITE_URL or STELLA_ADMIN_TOKEN/STELLA_ADMIN_SECRET.\n",
  );
  process.exit(1);
}

for (const row of rows) {
  const response = await fetch(`${siteUrl}/api/admin/native-integrations/upsert`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${row.id}: ${response.status} ${text.slice(0, 500)}`);
  }
}

process.stdout.write(`${JSON.stringify({ published: rows.length }, null, 2)}\n`);
