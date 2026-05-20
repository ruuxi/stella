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
const apply = process.argv.includes("--apply");

const GOOGLE_IDS = new Set([
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
  !GOOGLE_IDS.has(entry.id) &&
  !entry.id.startsWith("google") &&
  !BACKEND_OWNED.has(entry.id) &&
  !API_KEY_ONLY.has(entry.id);

const rows = OAUTH_PROVIDER_CATALOG.filter(shouldPublish).map((entry) => ({
  id: entry.id,
  name: entry.name,
  provider: "composio",
  category: entry.category,
  auth: ["OAUTH2"],
  catalogToolCount: entry.catalogToolCount,
  description: entry.description,
  sourceUrl: entry.sourceUrl,
  connector: {
    type: "composio",
    toolkit: entry.id,
    provider: "composio",
  },
  enabled: true,
  usagePolicy: "ready",
}));

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
