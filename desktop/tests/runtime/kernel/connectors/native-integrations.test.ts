import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildNativeConnectorCatalog,
  enableNativeConnector,
  getNativeConnectorCatalogActions,
  getNativeConnectorCatalogEntry,
  listNativeConnectors,
} from "../../../../../runtime/kernel/connectors/native-integrations.js";
import { getOAuthProviderCatalog } from "../../../../../runtime/kernel/connectors/oauth-provider-catalog.js";
import { getNativeOAuthProviderConfig } from "../../../../../runtime/kernel/connectors/native-oauth-provider-config.js";

const roots: string[] = [];
const envKeysToRestore = [
  "STELLA_NATIVE_OAUTH_REDDIT_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_REDDIT_AUTHORIZATION_URL",
  "STELLA_NATIVE_OAUTH_REDDIT_TOKEN_URL",
  "STELLA_NATIVE_OAUTH_REDDIT_CALLBACK_URL",
  "STELLA_NATIVE_OAUTH_REDDIT_SCOPES",
  "STELLA_NATIVE_OAUTH_REDDIT_RESOURCE_URL",
  "STELLA_NATIVE_OAUTH_REDDIT_USES_PKCE",
  "STELLA_NATIVE_OAUTH_REDDIT_AUTHORIZATION_PARAMS_JSON",
  "STELLA_NATIVE_OAUTH_REDDIT_TOKEN_AUTH",
  "STELLA_NATIVE_OAUTH_TODOIST_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_TODOIST_CALLBACK_URL",
  "STELLA_NATIVE_OAUTH_TODOIST_CALLBACK_MODE",
  "STELLA_NATIVE_OAUTH_TODOIST_TOKEN_EXCHANGE",
  "STELLA_NATIVE_OAUTH_TODOIST_TOKEN_EXCHANGE_PROVIDER",
  "STELLA_NATIVE_OAUTH_TODOIST_SCOPES",
  "STELLA_NATIVE_OAUTH_SPOTIFY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DROPBOX_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_GITLAB_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BITBUCKET_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BOX_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_MAILCHIMP_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_CLICKUP_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_WEBFLOW_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_REDDIT_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_QUICKBOOKS_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_XERO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_ZENDESK_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_ZENDESK_SUBDOMAIN",
  "STELLA_NATIVE_OAUTH_LINKEDIN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SHOPIFY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SHOPIFY_SHOP_DOMAIN",
  "STELLA_NATIVE_OAUTH_SQUARE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_STRAVA_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SURVEY_MONKEY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DOCUSIGN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DIGITAL_OCEAN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_MURAL_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_CANVAS_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_CANVAS_INSTALL_URL",
  "STELLA_NATIVE_OAUTH_DATADOG_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DATADOG_SITE",
  "STELLA_NATIVE_OAUTH_WRIKE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_INTERCOM_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_KLAVIYO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BREVO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_YNAB_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_WEBEX_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_PRODUCTBOARD_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_GORGIAS_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_GORGIAS_SUBDOMAIN",
  "STELLA_NATIVE_OAUTH_CANVA_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BAMBOOHR_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BAMBOOHR_COMPANY_DOMAIN",
  "STELLA_NATIVE_OAUTH_TWITTER_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_TIKTOK_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DROPBOX_SIGN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_STORYBLOK_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SHIPPO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BOLDSIGN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_FOLLOW_UP_BOSS_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_MONEYBIRD_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_WORKABLE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BASECAMP_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BEEMINDER_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_FLY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_FATHOM_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_HUGGING_FACE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_WHOP_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_XATA_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_META_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_META_BACKEND_READY",
  "STELLA_NATIVE_OAUTH_PAGERDUTY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_CONTENTFUL_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DATABRICKS_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DATABRICKS_WORKSPACE_URL",
  "STELLA_NATIVE_OAUTH_EGNYTE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_EGNYTE_DOMAIN",
  "STELLA_NATIVE_OAUTH_APALEO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DIALPAD_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SERVICEM8_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_TIMELY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_KOMMO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_KOMMO_SUBDOMAIN",
  "STELLA_NATIVE_OAUTH_GONG_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SNOWFLAKE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SNOWFLAKE_ACCOUNT_URL",
  "STELLA_NATIVE_OAUTH_NETSUITE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_NETSUITE_ACCOUNT_ID",
  "STELLA_NATIVE_OAUTH_COUPA_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_COUPA_DOMAIN",
  "STELLA_NATIVE_OAUTH_D2LBRIGHTSPACE_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_D2LBRIGHTSPACE_RESOURCE_URL",
  "STELLA_NATIVE_OAUTH_BLACKBOARD_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BLACKBOARD_INSTANCE_URL",
  "STELLA_NATIVE_OAUTH_DUB_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BLACKBAUD_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_EXIST_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_OMNISEND_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_RAMP_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_BREX_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_WORKDAY_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_WORKDAY_HOST",
  "STELLA_NATIVE_OAUTH_WORKDAY_TENANT",
  "STELLA_NATIVE_OAUTH_YANDEX_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DYNAMICS365_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_DYNAMICS365_RESOURCE_URL",
  "STELLA_NATIVE_OAUTH_KIT_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_LEVER_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_LINKHUT_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_PRISMA_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_TONEDEN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_MICROSOFT_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_ATLASSIAN_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_ATLASSIAN_BACKEND_READY",
  "STELLA_NATIVE_OAUTH_ZOHO_CLIENT_ID",
  "STELLA_NATIVE_OAUTH_SALESFORCE_CLIENT_ID",
] as const;
const originalEnv = Object.fromEntries(
  envKeysToRestore.map((key) => [key, process.env[key]]),
);

afterEach(async () => {
  for (const key of envKeysToRestore) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

const createRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-native-connectors-"));
  roots.push(root);
  return root;
};

describe("native OAuth integration readiness", () => {
  it("keeps native Google Workspace as the fallback but lets the server catalog override it", async () => {
    const root = createRoot();
    const connectors = await listNativeConnectors(root);
    const ids = connectors.map((entry) => entry.id);

    expect(ids).toContain("gmail");
    expect(ids).toContain("googlecalendar");
    expect(ids).toContain("googledocs");
    expect(ids).toContain("googledrive");
    expect(ids).not.toContain("google_analytics");
    expect(ids).not.toContain("googlesheets");
    expect(ids).not.toContain("googleslides");
    expect(ids).not.toContain("googlemeet");
    expect(connectors.find((entry) => entry.id === "gmail")).toMatchObject({
      provider: "google-workspace",
    });

    // Server catalog entries OVERLAY the bundled catalog (by id) instead of
    // replacing it: gmail flips to the backend provider while the other
    // bundled entries (googlecalendar, …) remain resolvable for the
    // Store/connect paths.
    const overlaid = buildNativeConnectorCatalog([
      {
        id: "gmail",
        name: "Gmail",
        category: "email",
        auth: ["OAUTH2"],
        catalogToolCount: 61,
        availability: "ready",
        provider: "backend-composio",
        description: "Connect Gmail through Composio.",
        connectable: true,
        backendConnector: {
          type: "composio",
          toolkit: "GMAIL",
        },
      },
    ]);
    expect(
      overlaid.filter((entry) => entry.id === "gmail"),
    ).toEqual([
      expect.objectContaining({
        id: "gmail",
        provider: "backend-composio",
      }),
    ]);
    expect(
      overlaid.find((entry) => entry.id === "googlecalendar"),
    ).toMatchObject({ provider: "google-workspace" });
  });

  it("keeps backend-owned communication integrations out of the OAuth catalog source and Store surface", async () => {
    const root = createRoot();
    const excludedIds = [
      "borneo",
      "clockify",
      "discord",
      "discordbot",
      "epic_games",
      "insighto_ai",
      "lodgify",
      "matterport",
      "microsoft_teams",
      "parma",
      "pinecone",
      "recruitee",
      "scheduleonce",
      "sendloop",
      "slack",
      "slackbot",
      "tally",
      "ticketmaster",
      "trello",
      "whatsapp",
      "wix",
      "zoominfo",
    ];

    const oauthProviderCatalog = getOAuthProviderCatalog();
    expect(oauthProviderCatalog.every((entry) => entry.auth[0] === "OAUTH2"))
      .toBe(true);
    expect(
      oauthProviderCatalog.filter((entry) =>
        entry.auth.some((auth) => auth.includes("API_KEY")),
      ),
    ).toEqual([]);
    expect(
      oauthProviderCatalog.filter((entry) => excludedIds.includes(entry.id)),
    ).toEqual([]);

    const connectors = await listNativeConnectors(root);
    expect(
      connectors.filter((entry) => excludedIds.includes(entry.id)),
    ).toEqual([]);
  });

  it("does not mark backend-exchange providers connectable until backend config is confirmed", async () => {
    const root = createRoot();
    process.env.STELLA_NATIVE_OAUTH_TODOIST_CLIENT_ID = "todoist-client";

    const withoutBackend = await listNativeConnectors(root);
    expect(
      withoutBackend.find((entry) => entry.id === "todoist")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "todoist"),
    ).toMatchObject({
      oauthSetupStatus: "missing_backend_exchange",
    });
    await expect(enableNativeConnector(root, "todoist")).rejects.toThrow(
      "secure server connection is not ready",
    );

    const configuredBackendProviders = new Set(["todoist"]);
    const withBackend = await listNativeConnectors(root, {
      configuredBackendProviders,
    });
    expect(
      withBackend.find((entry) => entry.id === "todoist")?.connectable,
    ).toBe(true);
    expect(withBackend.find((entry) => entry.id === "todoist")).toMatchObject({
      oauthSetupStatus: "ready",
    });
    await expect(
      enableNativeConnector(root, "todoist", "cli", {
        configuredBackendProviders,
      }),
    ).resolves.toMatchObject({
      id: "todoist",
      enabled: true,
    });
  });

  it("treats built-in backend-exchange placeholders as missing OAuth app setup", async () => {
    const root = createRoot();

    const connectors = await listNativeConnectors(root);
    expect(connectors.find((entry) => entry.id === "todoist")).toMatchObject({
      connectable: false,
      oauthSetupStatus: "missing_oauth_app",
    });
    await expect(enableNativeConnector(root, "todoist", "cli")).rejects.toThrow(
      "provider setup is not ready",
    );
  });

  it("surfaces recovered OAuth catalog actions separately from callable transport tools", async () => {
    const root = createRoot();

    const configuredBackendProviders = new Set([
      "monday",
      "notion",
      "typeform",
    ]);
    const configuredExternalCallbackProviders = new Set(["notion"]);
    const connectors = await listNativeConnectors(root, {
      configuredBackendProviders,
      configuredExternalCallbackProviders,
    });
    const notion = connectors.find((entry) => entry.id === "notion");
    expect(notion).toMatchObject({
      connectable: true,
      toolCount: 1,
      actionCount: 45,
    });

    const notionEntry = getNativeConnectorCatalogEntry("notion");
    expect(notionEntry).toBeTruthy();
    const actions = getNativeConnectorCatalogActions(notionEntry!);
    expect(actions.length).toBe(45);
    expect(actions.some((action) => /database/i.test(action.name))).toBe(true);
    expect(connectors.find((entry) => entry.id === "typeform")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 44,
      toolCount: 1,
    });
    expect(connectors.find((entry) => entry.id === "monday")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 132,
      toolCount: 1,
    });

    const enabled = await enableNativeConnector(root, "notion", "cli", {
      configuredBackendProviders,
      configuredExternalCallbackProviders,
    });
    expect(enabled).toMatchObject({
      id: "notion",
      toolCount: 1,
      actionCount: 45,
    });
    const actionsMarkdown = await readFile(
      path.join(root, "skills", "notion", "ACTIONS.md"),
      "utf-8",
    );
    expect(actionsMarkdown).toContain("Catalog Actions");
    expect(actionsMarkdown).toContain("recovered OAuth action references");
    expect(actionsMarkdown).toContain("choose the right Notion API endpoint");

    const skillMarkdown = await readFile(
      path.join(root, "skills", "notion", "SKILL.md"),
      "utf-8",
    );
    expect(skillMarkdown).toContain("Inspect executable tools");
    expect(skillMarkdown).toContain("stella-connect catalog-actions notion");
    expect(skillMarkdown).toContain("stella-connect call notion /path");
    expect(skillMarkdown).toContain("## Executable Tools");
  });

  it("does not expose OAuth catalog providers with empty recovered action references", async () => {
    const root = createRoot();

    const connectors = await listNativeConnectors(root);
    const oauthCatalogEntries = connectors.filter(
      (entry) => entry.provider === "oauth-catalog",
    );

    expect(oauthCatalogEntries.length).toBeGreaterThan(100);
    expect(
      oauthCatalogEntries.filter((entry) => entry.catalogToolCount <= 0),
    ).toEqual([]);
    for (const entry of oauthCatalogEntries) {
      expect(getNativeConnectorCatalogActions(entry).length).toBeGreaterThan(0);
    }
  });

  it("marks recovered OAuth catalog providers without native app credentials as setup-required", async () => {
    const root = createRoot();

    const connectors = await listNativeConnectors(root);
    const basecamp = connectors.find((entry) => entry.id === "basecamp");
    const outlook = connectors.find((entry) => entry.id === "outlook");

    expect(basecamp).toMatchObject({
      connectable: false,
      oauthSetupStatus: "missing_oauth_app",
      oauthProviderTemplate: true,
      actionCount: 13,
    });
    expect(basecamp?.oauthSetupMessage).toContain("OAuth app");
    await expect(
      enableNativeConnector(root, "basecamp", "cli"),
    ).rejects.toThrow("provider setup");
    expect(outlook).toMatchObject({
      connectable: false,
      oauthSetupStatus: "missing_oauth_app",
      oauthSetupGroup: {
        id: "microsoft",
        name: "Microsoft",
      },
    });
    expect(outlook?.oauthSetupMessage).toContain("one Microsoft connection setup");
  });

  it("marks hosted external-callback direct PKCE providers connectable", async () => {
    const root = createRoot();

    const connectors = await listNativeConnectors(root);
    expect(
      connectors.find((entry) => entry.id === "airtable")?.connectable,
    ).toBe(true);
    expect(connectors.find((entry) => entry.id === "sentry")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 205,
    });
    expect(
      connectors.find((entry) => entry.id === "capsule_crm"),
    ).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 109,
      toolCount: 1,
    });
    expect(connectors.find((entry) => entry.id === "cal")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 168,
      toolCount: 1,
    });
    expect(connectors.find((entry) => entry.id === "zeplin")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 24,
      toolCount: 1,
    });
    expect(connectors.find((entry) => entry.id === "dart")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 20,
      toolCount: 1,
    });
    expect(
      connectors.find((entry) => entry.id === "stack_exchange"),
    ).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 124,
      toolCount: 1,
    });
    await expect(
      enableNativeConnector(root, "airtable", "cli"),
    ).resolves.toMatchObject({
      id: "airtable",
      enabled: true,
      actionCount: 23,
    });
  });

  it("reuses the Stella Google OAuth client for YouTube without making Google Workspace a snowflake", async () => {
    const root = createRoot();

    const connectors = await listNativeConnectors(root);
    const youtube = connectors.find((entry) => entry.id === "youtube");

    expect(youtube).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 47,
      toolCount: 1,
    });
    expect(connectors.find((entry) => entry.id === "gmail")).toMatchObject({
      provider: "google-workspace",
    });
    await expect(
      enableNativeConnector(root, "youtube", "cli"),
    ).resolves.toMatchObject({
      id: "youtube",
      enabled: true,
      actionCount: 47,
    });
  });

  it("can mark a recovered OAuth provider ready through env-configured installed-app OAuth", async () => {
    const root = createRoot();
    process.env.STELLA_NATIVE_OAUTH_REDDIT_CLIENT_ID = "reddit-client";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_AUTHORIZATION_URL =
      "https://www.reddit.com/api/v1/authorize";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_TOKEN_URL =
      "https://www.reddit.com/api/v1/access_token";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_CALLBACK_URL =
      "http://127.0.0.1:48743/callback/reddit";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_SCOPES =
      "identity read submit edit history save vote mysubreddits flair";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_RESOURCE_URL =
      "https://oauth.reddit.com";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_USES_PKCE = "0";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_AUTHORIZATION_PARAMS_JSON =
      JSON.stringify({ duration: "permanent" });
    process.env.STELLA_NATIVE_OAUTH_REDDIT_TOKEN_AUTH = "basic";

    const connectors = await listNativeConnectors(root);
    expect(connectors.find((entry) => entry.id === "reddit")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
      actionCount: 22,
      toolCount: 1,
    });
    await expect(
      enableNativeConnector(root, "reddit", "cli"),
    ).resolves.toMatchObject({
      id: "reddit",
      enabled: true,
      actionCount: 22,
    });
  });

  it("lets provider registrations override built-in OAuth app details without code changes", async () => {
    const root = createRoot();
    process.env.STELLA_NATIVE_OAUTH_TODOIST_CLIENT_ID = "new-todoist-client";
    process.env.STELLA_NATIVE_OAUTH_TODOIST_CALLBACK_URL =
      "https://stella.sh/oauth/todoist/callback";
    process.env.STELLA_NATIVE_OAUTH_TODOIST_CALLBACK_MODE = "external";
    process.env.STELLA_NATIVE_OAUTH_TODOIST_TOKEN_EXCHANGE = "backend";
    process.env.STELLA_NATIVE_OAUTH_TODOIST_TOKEN_EXCHANGE_PROVIDER =
      "todoist";
    process.env.STELLA_NATIVE_OAUTH_TODOIST_SCOPES = "data:read data:delete";

    const config = getNativeOAuthProviderConfig("todoist");
    expect(config).toMatchObject({
      clientId: "new-todoist-client",
      callbackUrl: "https://stella.sh/oauth/todoist/callback",
      callbackMode: "external",
      scopes: ["data:read", "data:delete"],
      tokenExchange: {
        type: "backend",
        provider: "todoist",
      },
    });

    const connectors = await listNativeConnectors(root, {
      configuredBackendProviders: new Set(["todoist"]),
    });
    expect(connectors.find((entry) => entry.id === "todoist")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
    });
  });

  it("has env-backed templates for direct PKCE provider registrations", async () => {
    const root = createRoot();
    process.env.STELLA_NATIVE_OAUTH_SPOTIFY_CLIENT_ID = "spotify-client";
    process.env.STELLA_NATIVE_OAUTH_DROPBOX_CLIENT_ID = "dropbox-client";
    process.env.STELLA_NATIVE_OAUTH_GITLAB_CLIENT_ID = "gitlab-client";
    process.env.STELLA_NATIVE_OAUTH_REDDIT_CLIENT_ID = "reddit-client";

    const connectors = await listNativeConnectors(root);

    for (const id of ["spotify", "dropbox", "gitlab", "reddit"]) {
      expect(connectors.find((entry) => entry.id === id)).toMatchObject({
        connectable: true,
        oauthSetupStatus: "ready",
        toolCount: 1,
      });
    }
    expect(getNativeOAuthProviderConfig("spotify")).toMatchObject({
      authorizationEndpoint: "https://accounts.spotify.com/authorize",
      usesPkce: true,
      resourceUrl: "https://api.spotify.com/v1",
    });
    expect(getNativeOAuthProviderConfig("dropbox")).toMatchObject({
      authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
      usesPkce: true,
      resourceUrl: "https://api.dropboxapi.com/2",
    });
    expect(getNativeOAuthProviderConfig("reddit")).toMatchObject({
      authorizationEndpoint: "https://www.reddit.com/api/v1/authorize",
      tokenEndpoint: "https://www.reddit.com/api/v1/access_token",
      tokenAuth: "basic",
      resourceUrl: "https://oauth.reddit.com",
    });
  });

  it("has env-backed templates for backend-exchange provider registrations", async () => {
    const root = createRoot();
    for (const id of [
      "BITBUCKET",
      "BOX",
      "HUBSPOT",
      "MAILCHIMP",
      "CLICKUP",
      "WEBFLOW",
      "QUICKBOOKS",
      "XERO",
      "LINKEDIN",
      "SQUARE",
      "STRAVA",
      "SURVEY_MONKEY",
      "DOCUSIGN",
      "DIGITAL_OCEAN",
      "MURAL",
      "WRIKE",
      "INTERCOM",
      "KLAVIYO",
      "BREVO",
      "YNAB",
      "WEBEX",
      "PRODUCTBOARD",
      "CANVA",
      "TWITTER",
      "TIKTOK",
      "DROPBOX_SIGN",
      "STORYBLOK",
      "SHIPPO",
      "BOLDSIGN",
      "FOLLOW_UP_BOSS",
      "MONEYBIRD",
      "WORKABLE",
      "BASECAMP",
      "BEEMINDER",
      "FLY",
      "FATHOM",
      "HUGGING_FACE",
      "WHOP",
      "XATA",
      "PAGERDUTY",
      "CONTENTFUL",
      "DATABRICKS",
      "EGNYTE",
      "APALEO",
      "DIALPAD",
      "SERVICEM8",
      "TIMELY",
      "KOMMO",
      "GONG",
      "SNOWFLAKE",
      "NETSUITE",
      "COUPA",
      "D2LBRIGHTSPACE",
      "BLACKBOARD",
      "DUB",
      "BLACKBAUD",
      "EXIST",
      "OMNISEND",
      "RAMP",
      "BREX",
      "WORKDAY",
      "YANDEX",
      "DYNAMICS365",
      "KIT",
      "LEVER",
      "LINKHUT",
      "PRISMA",
      "TONEDEN",
    ]) {
      process.env[`STELLA_NATIVE_OAUTH_${id}_CLIENT_ID`] =
        `${id.toLowerCase()}-client`;
    }
    process.env.STELLA_NATIVE_OAUTH_ZENDESK_CLIENT_ID = "zendesk-client";
    process.env.STELLA_NATIVE_OAUTH_ZENDESK_SUBDOMAIN = "stella-test";
    process.env.STELLA_NATIVE_OAUTH_SHOPIFY_CLIENT_ID = "shopify-client";
    process.env.STELLA_NATIVE_OAUTH_SHOPIFY_SHOP_DOMAIN = "stella-shop";
    process.env.STELLA_NATIVE_OAUTH_CANVAS_CLIENT_ID = "canvas-client";
    process.env.STELLA_NATIVE_OAUTH_CANVAS_INSTALL_URL =
      "https://canvas.example.edu";
    process.env.STELLA_NATIVE_OAUTH_DATADOG_CLIENT_ID = "datadog-client";
    process.env.STELLA_NATIVE_OAUTH_DATADOG_SITE =
      "https://app.datadoghq.com";
    process.env.STELLA_NATIVE_OAUTH_GORGIAS_CLIENT_ID = "gorgias-client";
    process.env.STELLA_NATIVE_OAUTH_GORGIAS_SUBDOMAIN = "stella-help";
    process.env.STELLA_NATIVE_OAUTH_BAMBOOHR_CLIENT_ID = "bamboohr-client";
    process.env.STELLA_NATIVE_OAUTH_BAMBOOHR_COMPANY_DOMAIN = "stella-people";
    process.env.STELLA_NATIVE_OAUTH_META_CLIENT_ID = "meta-client";
    process.env.STELLA_NATIVE_OAUTH_DATABRICKS_WORKSPACE_URL =
      "https://dbc-example.cloud.databricks.com";
    process.env.STELLA_NATIVE_OAUTH_EGNYTE_DOMAIN = "stella.egnyte.com";
    process.env.STELLA_NATIVE_OAUTH_KOMMO_SUBDOMAIN = "stella";
    process.env.STELLA_NATIVE_OAUTH_SNOWFLAKE_ACCOUNT_URL =
      "https://stella.snowflakecomputing.com";
    process.env.STELLA_NATIVE_OAUTH_NETSUITE_ACCOUNT_ID = "1234567";
    process.env.STELLA_NATIVE_OAUTH_COUPA_DOMAIN = "stella.coupahost.com";
    process.env.STELLA_NATIVE_OAUTH_D2LBRIGHTSPACE_RESOURCE_URL =
      "https://stella.brightspace.com";
    process.env.STELLA_NATIVE_OAUTH_BLACKBOARD_INSTANCE_URL =
      "https://stella.blackboard.com";
    process.env.STELLA_NATIVE_OAUTH_WORKDAY_HOST = "wd2.workday.com";
    process.env.STELLA_NATIVE_OAUTH_WORKDAY_TENANT = "stella";
    process.env.STELLA_NATIVE_OAUTH_DYNAMICS365_RESOURCE_URL =
      "https://stella.crm.dynamics.com";

    const withoutBackend = await listNativeConnectors(root);
    expect(withoutBackend.find((entry) => entry.id === "twitter")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
    });
    expect(withoutBackend.find((entry) => entry.id === "beeminder")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
    });
    expect(
      withoutBackend.find((entry) => entry.id === "hugging_face"),
    ).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
    });
    expect(
      withoutBackend.find((entry) => entry.id === "databricks"),
    ).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
    });
    for (const id of [
      "bitbucket",
      "box",
      "hubspot",
      "mailchimp",
      "clickup",
      "webflow",
      "quickbooks",
      "xero",
      "zendesk",
      "linkedin",
      "shopify",
      "square",
      "strava",
      "survey_monkey",
      "docusign",
      "digital_ocean",
      "mural",
      "canvas",
      "datadog",
      "wrike",
      "intercom",
      "klaviyo",
      "brevo",
      "ynab",
      "webex",
      "productboard",
      "gorgias",
      "canva",
      "bamboohr",
      "tiktok",
      "dropbox_sign",
      "storyblok",
      "shippo",
      "boldsign",
      "follow_up_boss",
      "moneybird",
      "workable",
      "basecamp",
      "fly",
      "fathom",
      "whop",
      "xata",
      "facebook",
      "instagram",
      "metaads",
      "pagerduty",
      "contentful",
      "egnyte",
      "apaleo",
      "dialpad",
      "servicem8",
      "timely",
      "kommo",
      "gong",
      "snowflake",
      "netsuite",
      "coupa",
      "d2lbrightspace",
      "blackboard",
      "dub",
      "blackbaud",
      "exist",
      "omnisend",
      "ramp",
      "brex",
      "workday",
      "yandex",
      "dynamics365",
      "kit",
      "lever",
      "linkhut",
      "prisma",
      "toneden",
    ]) {
      expect(withoutBackend.find((entry) => entry.id === id)).toMatchObject({
        connectable: false,
        oauthSetupStatus: "missing_backend_exchange",
      });
    }

    const withBackend = await listNativeConnectors(root, {
      configuredBackendProviders: new Set([
        "bitbucket",
        "box",
        "hubspot",
        "mailchimp",
        "clickup",
        "webflow",
        "quickbooks",
        "xero",
        "zendesk",
        "linkedin",
        "shopify",
        "square",
        "strava",
        "survey_monkey",
        "docusign",
        "digital_ocean",
        "mural",
        "canvas",
        "datadog",
        "wrike",
        "intercom",
        "klaviyo",
        "brevo",
        "ynab",
        "webex",
        "productboard",
        "gorgias",
        "canva",
        "bamboohr",
        "tiktok",
        "dropbox_sign",
        "storyblok",
        "shippo",
        "boldsign",
        "follow_up_boss",
        "moneybird",
        "workable",
        "basecamp",
        "fly",
        "fathom",
        "whop",
        "xata",
        "meta",
        "pagerduty",
        "contentful",
        "egnyte",
        "apaleo",
        "dialpad",
        "servicem8",
        "timely",
        "kommo",
        "gong",
        "snowflake",
        "netsuite",
        "coupa",
        "d2lbrightspace",
        "blackboard",
        "dub",
        "blackbaud",
        "exist",
        "omnisend",
        "ramp",
        "brex",
        "workday",
        "yandex",
        "dynamics365",
        "kit",
        "lever",
        "linkhut",
        "prisma",
        "toneden",
      ]),
    });
    for (const id of [
      "bitbucket",
      "box",
      "hubspot",
      "mailchimp",
      "clickup",
      "webflow",
      "quickbooks",
      "xero",
      "zendesk",
      "linkedin",
      "shopify",
      "square",
      "strava",
      "survey_monkey",
      "docusign",
      "digital_ocean",
      "mural",
      "canvas",
      "datadog",
      "wrike",
      "intercom",
      "klaviyo",
      "brevo",
      "ynab",
      "webex",
      "productboard",
      "gorgias",
      "canva",
      "bamboohr",
      "tiktok",
      "dropbox_sign",
      "storyblok",
      "shippo",
      "boldsign",
      "follow_up_boss",
      "moneybird",
      "workable",
      "basecamp",
      "fly",
      "fathom",
      "whop",
      "xata",
      "facebook",
      "instagram",
      "metaads",
      "pagerduty",
      "contentful",
      "egnyte",
      "apaleo",
      "dialpad",
      "servicem8",
      "timely",
      "kommo",
      "gong",
      "snowflake",
      "netsuite",
      "coupa",
      "d2lbrightspace",
      "blackboard",
      "dub",
      "blackbaud",
      "exist",
      "omnisend",
      "ramp",
      "brex",
      "workday",
      "yandex",
      "dynamics365",
      "kit",
      "lever",
      "linkhut",
      "prisma",
      "toneden",
    ]) {
      expect(withBackend.find((entry) => entry.id === id)).toMatchObject({
        connectable: true,
        oauthSetupStatus: "ready",
        toolCount: 1,
      });
    }
    expect(getNativeOAuthProviderConfig("quickbooks")).toMatchObject({
      authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
      tokenEndpoint:
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      tokenAuth: "basic",
    });
    expect(getNativeOAuthProviderConfig("xero")).toMatchObject({
      authorizationEndpoint:
        "https://login.xero.com/identity/connect/authorize",
      tokenEndpoint: "https://identity.xero.com/connect/token",
      tokenAuth: "basic",
    });
    expect(getNativeOAuthProviderConfig("zendesk")).toMatchObject({
      authorizationEndpoint:
        "https://stella-test.zendesk.com/oauth/authorizations/new",
      tokenEndpoint: "https://stella-test.zendesk.com/oauth/tokens",
    });
    expect(getNativeOAuthProviderConfig("linkedin")).toMatchObject({
      authorizationEndpoint:
        "https://www.linkedin.com/oauth/v2/authorization",
      tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
    });
    expect(getNativeOAuthProviderConfig("shopify")).toMatchObject({
      authorizationEndpoint:
        "https://stella-shop.myshopify.com/admin/oauth/authorize",
      tokenEndpoint: "https://stella-shop.myshopify.com/admin/oauth/access_token",
    });
    expect(getNativeOAuthProviderConfig("strava")).toMatchObject({
      authorizationEndpoint: "https://www.strava.com/oauth/authorize",
      tokenEndpoint: "https://www.strava.com/oauth/token",
    });
    expect(getNativeOAuthProviderConfig("survey_monkey")).toMatchObject({
      authorizationEndpoint: "https://api.surveymonkey.com/oauth/authorize",
      tokenEndpoint: "https://api.surveymonkey.com/oauth/token",
    });
    expect(getNativeOAuthProviderConfig("digital_ocean")).toMatchObject({
      authorizationEndpoint:
        "https://cloud.digitalocean.com/v1/oauth/authorize",
      tokenEndpoint: "https://cloud.digitalocean.com/v1/oauth/token",
    });
    expect(getNativeOAuthProviderConfig("mural")).toMatchObject({
      authorizationEndpoint:
        "https://app.mural.co/api/public/v1/authorization/oauth2/authorize",
      tokenEndpoint:
        "https://app.mural.co/api/public/v1/authorization/oauth2/token",
    });
    expect(getNativeOAuthProviderConfig("canvas")).toMatchObject({
      authorizationEndpoint: "https://canvas.example.edu/login/oauth2/auth",
      tokenEndpoint: "https://canvas.example.edu/login/oauth2/token",
    });
    expect(getNativeOAuthProviderConfig("datadog")).toMatchObject({
      authorizationEndpoint: "https://app.datadoghq.com/oauth2/v1/authorize",
      tokenEndpoint: "https://api.datadoghq.com/oauth2/v1/token",
    });
    expect(getNativeOAuthProviderConfig("wrike")).toMatchObject({
      authorizationEndpoint: "https://login.wrike.com/oauth2/authorize/v4",
      tokenEndpoint: "https://login.wrike.com/oauth2/token",
      scopeSeparator: ",",
    });
    expect(getNativeOAuthProviderConfig("intercom")).toMatchObject({
      authorizationEndpoint: "https://app.intercom.com/oauth",
      tokenEndpoint: "https://api.intercom.io/auth/eagle/token",
    });
    expect(getNativeOAuthProviderConfig("klaviyo")).toMatchObject({
      authorizationEndpoint: "https://www.klaviyo.com/oauth/authorize",
      tokenEndpoint: "https://a.klaviyo.com/oauth/token",
      usesPkce: true,
      tokenAuth: "basic",
    });
    expect(getNativeOAuthProviderConfig("brevo")).toMatchObject({
      authorizationEndpoint:
        "https://oauth.brevo.com/realms/partner/oauth/authorize",
      tokenEndpoint: "https://oauth.brevo.com/realms/partner/oauth/token",
      scopes: ["all"],
    });
    expect(getNativeOAuthProviderConfig("ynab")).toMatchObject({
      authorizationEndpoint: "https://app.ynab.com/oauth/authorize",
      tokenEndpoint: "https://app.ynab.com/oauth/token",
      usesPkce: true,
      resourceUrl: "https://api.ynab.com/v1",
    });
    expect(getNativeOAuthProviderConfig("webex")).toMatchObject({
      authorizationEndpoint: "https://webexapis.com/v1/authorize",
      tokenEndpoint: "https://webexapis.com/v1/access_token",
      resourceUrl: "https://webexapis.com/v1",
    });
    expect(getNativeOAuthProviderConfig("productboard")).toMatchObject({
      authorizationEndpoint: "https://app.productboard.com/oauth2/authorize",
      tokenEndpoint: "https://app.productboard.com/oauth2/token",
      resourceUrl: "https://api.productboard.com",
    });
    expect(getNativeOAuthProviderConfig("gorgias")).toMatchObject({
      authorizationEndpoint: "https://stella-help.gorgias.com/oauth/authorize",
      tokenEndpoint: "https://stella-help.gorgias.com/oauth/token",
      tokenAuth: "basic",
    });
    expect(getNativeOAuthProviderConfig("canva")).toMatchObject({
      authorizationEndpoint: "https://www.canva.com/api/oauth/authorize",
      tokenEndpoint: "https://api.canva.com/rest/v1/oauth/token",
      usesPkce: true,
      tokenAuth: "basic",
    });
    expect(getNativeOAuthProviderConfig("bamboohr")).toMatchObject({
      authorizationEndpoint: "https://stella-people.bamboohr.com/authorize.php",
      tokenEndpoint:
        "https://stella-people.bamboohr.com/token.php?request=token",
      scopeSeparator: "+",
    });
    expect(getNativeOAuthProviderConfig("twitter")).toMatchObject({
      authorizationEndpoint: "https://x.com/i/oauth2/authorize",
      tokenEndpoint: "https://api.x.com/2/oauth2/token",
      usesPkce: true,
      resourceUrl: "https://api.x.com/2",
    });
    expect(getNativeOAuthProviderConfig("tiktok")).toMatchObject({
      authorizationEndpoint: "https://www.tiktok.com/v2/auth/authorize/",
      tokenEndpoint: "https://open.tiktokapis.com/v2/oauth/token/",
      authorizationClientIdParam: "client_key",
      usesPkce: true,
    });
    expect(getNativeOAuthProviderConfig("dropbox_sign")).toMatchObject({
      authorizationEndpoint: "https://app.hellosign.com/oauth/authorize",
      tokenEndpoint: "https://app.hellosign.com/oauth/token",
      resourceUrl: "https://api.hellosign.com/v3",
    });
    expect(getNativeOAuthProviderConfig("storyblok")).toMatchObject({
      authorizationEndpoint: "https://app.storyblok.com/oauth/authorize",
      tokenEndpoint: "https://app.storyblok.com/oauth/token",
      usesPkce: true,
      resourceUrl: "https://mapi.storyblok.com/v1",
    });
    expect(getNativeOAuthProviderConfig("shippo")).toMatchObject({
      authorizationEndpoint: "https://goshippo.com/oauth/authorize",
      tokenEndpoint: "https://goshippo.com/oauth/access_token",
      scopes: ["*"],
    });
    expect(getNativeOAuthProviderConfig("boldsign")).toMatchObject({
      authorizationEndpoint: "https://account.boldsign.com/connect/authorize",
      tokenEndpoint: "https://account.boldsign.com/connect/token",
      usesPkce: true,
      resourceUrl: "https://api.boldsign.com/v1",
    });
    expect(getNativeOAuthProviderConfig("follow_up_boss")).toMatchObject({
      authorizationEndpoint: "https://app.followupboss.com/oauth/authorize",
      tokenEndpoint: "https://app.followupboss.com/oauth/token",
      authorizationParams: {
        response_type: "auth_code",
        prompt: "login",
      },
      tokenAuth: "basic",
    });
    expect(getNativeOAuthProviderConfig("moneybird")).toMatchObject({
      authorizationEndpoint: "https://moneybird.com/oauth/authorize",
      tokenEndpoint: "https://moneybird.com/oauth/token",
      resourceUrl: "https://moneybird.com/api/v2",
    });
    expect(getNativeOAuthProviderConfig("workable")).toMatchObject({
      authorizationEndpoint: "https://www.workable.com/oauth/authorize",
      tokenEndpoint: "https://www.workable.com/oauth/token",
      authorizationParams: { resource: "user" },
      scopeSeparator: "+",
    });
    expect(getNativeOAuthProviderConfig("basecamp")).toMatchObject({
      authorizationEndpoint:
        "https://launchpad.37signals.com/authorization/new",
      tokenEndpoint: "https://launchpad.37signals.com/authorization/token",
    });
    expect(getNativeOAuthProviderConfig("beeminder")).toMatchObject({
      authorizationEndpoint: "https://www.beeminder.com/apps/authorize",
      responseType: "token",
      resourceUrl: "https://www.beeminder.com/api/v1",
    });
    expect(getNativeOAuthProviderConfig("fly")).toMatchObject({
      authorizationEndpoint: "https://api.fly.io/oauth/authorize",
      tokenEndpoint: "https://api.fly.io/oauth/token",
      scopes: ["read"],
    });
    expect(getNativeOAuthProviderConfig("fathom")).toMatchObject({
      authorizationEndpoint:
        "https://fathom.video/external/v1/oauth2/authorize",
      tokenEndpoint: "https://fathom.video/external/v1/oauth2/token",
      scopes: ["public_api"],
      resourceUrl: "https://api.fathom.ai/external/v1",
    });
    expect(getNativeOAuthProviderConfig("hugging_face")).toMatchObject({
      authorizationEndpoint: "https://huggingface.co/oauth/authorize",
      tokenEndpoint: "https://huggingface.co/oauth/token",
      usesPkce: true,
      resourceUrl: "https://huggingface.co/api",
    });
    expect(getNativeOAuthProviderConfig("whop")).toMatchObject({
      authorizationEndpoint: "https://api.whop.com/oauth/authorize",
      tokenEndpoint: "https://api.whop.com/oauth/token",
      usesPkce: true,
      scopes: ["openid", "profile", "email"],
      resourceUrl: "https://api.whop.com/api/v5",
    });
    expect(getNativeOAuthProviderConfig("xata")).toMatchObject({
      authorizationEndpoint: "https://app.xata.io/integrations/oauth/authorize",
      tokenEndpoint: "https://app.xata.io/api/integrations/oauth/token",
      usesPkce: false,
      scopes: ["admin:all"],
      resourceUrl: "https://api.xata.tech",
    });
    expect(getNativeOAuthProviderConfig("facebook")).toMatchObject({
      authorizationEndpoint: "https://www.facebook.com/v23.0/dialog/oauth",
      tokenEndpoint: "https://graph.facebook.com/v23.0/oauth/access_token",
      callbackId: "meta",
      tokenExchange: { type: "backend", provider: "meta" },
      scopeSeparator: ",",
      resourceUrl: "https://graph.facebook.com/v23.0",
    });
    expect(getNativeOAuthProviderConfig("instagram")).toMatchObject({
      tokenKey: "native-oauth:meta",
      callbackId: "meta",
      tokenExchange: { type: "backend", provider: "meta" },
    });
    expect(getNativeOAuthProviderConfig("metaads")).toMatchObject({
      tokenKey: "native-oauth:meta",
      callbackId: "meta",
      tokenExchange: { type: "backend", provider: "meta" },
    });
    expect(getNativeOAuthProviderConfig("pagerduty")).toMatchObject({
      authorizationEndpoint: "https://identity.pagerduty.com/oauth/authorize",
      tokenEndpoint: "https://identity.pagerduty.com/oauth/token",
      usesPkce: true,
      resourceUrl: "https://api.pagerduty.com",
    });
    expect(getNativeOAuthProviderConfig("contentful")).toMatchObject({
      authorizationEndpoint: "https://be.contentful.com/oauth/authorize",
      tokenEndpoint: "https://be.contentful.com/oauth/token",
      scopes: ["content_management_manage"],
      resourceUrl: "https://api.contentful.com",
    });
    expect(getNativeOAuthProviderConfig("databricks")).toMatchObject({
      authorizationEndpoint:
        "https://dbc-example.cloud.databricks.com/oidc/v1/authorize",
      tokenEndpoint: "https://dbc-example.cloud.databricks.com/oidc/v1/token",
      usesPkce: true,
      scopes: ["all-apis", "offline_access"],
      resourceUrl: "https://dbc-example.cloud.databricks.com/api/2.0",
    });
    expect(getNativeOAuthProviderConfig("egnyte")).toMatchObject({
      authorizationEndpoint: "https://stella.egnyte.com/puboauth/token",
      tokenEndpoint: "https://stella.egnyte.com/puboauth/token",
      resourceUrl: "https://stella.egnyte.com/pubapi/v1",
    });
    expect(getNativeOAuthProviderConfig("apaleo")).toMatchObject({
      authorizationEndpoint: "https://identity.apaleo.com/connect/authorize",
      tokenEndpoint: "https://identity.apaleo.com/connect/token",
      resourceUrl: "https://api.apaleo.com",
    });
    expect(getNativeOAuthProviderConfig("dialpad")).toMatchObject({
      authorizationEndpoint: "https://dialpad.com/oauth2/authorize",
      tokenEndpoint: "https://dialpad.com/oauth2/token",
      usesPkce: true,
      resourceUrl: "https://dialpad.com/api/v2",
    });
    expect(getNativeOAuthProviderConfig("servicem8")).toMatchObject({
      authorizationEndpoint: "https://go.servicem8.com/oauth/authorize",
      tokenEndpoint: "https://go.servicem8.com/oauth/access_token",
      resourceUrl: "https://api.servicem8.com/api_1.0",
    });
    expect(getNativeOAuthProviderConfig("timely")).toMatchObject({
      authorizationEndpoint: "https://api.timelyapp.com/1.1/oauth/authorize",
      tokenEndpoint: "https://api.timelyapp.com/1.1/oauth/token",
      resourceUrl: "https://api.timelyapp.com/1.1",
    });
    expect(getNativeOAuthProviderConfig("kommo")).toMatchObject({
      authorizationEndpoint: "https://www.kommo.com/oauth",
      tokenEndpoint: "https://stella.kommo.com/oauth2/access_token",
      resourceUrl: "https://stella.kommo.com/api/v4",
    });
    expect(getNativeOAuthProviderConfig("gong")).toMatchObject({
      authorizationEndpoint: "https://app.gong.io/oauth2/authorize",
      tokenEndpoint: "https://app.gong.io/oauth2/generate-customer-token",
      tokenAuth: "basic",
      resourceUrl: "https://api.gong.io",
    });
    expect(getNativeOAuthProviderConfig("snowflake")).toMatchObject({
      authorizationEndpoint:
        "https://stella.snowflakecomputing.com/oauth/authorize",
      tokenEndpoint:
        "https://stella.snowflakecomputing.com/oauth/token-request",
      scopes: ["session:role-any"],
      usesPkce: true,
      tokenAuth: "basic",
      resourceUrl: "https://stella.snowflakecomputing.com",
    });
    expect(getNativeOAuthProviderConfig("netsuite")).toMatchObject({
      authorizationEndpoint:
        "https://1234567.app.netsuite.com/app/login/oauth2/authorize.nl",
      tokenEndpoint:
        "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
      scopes: ["restlets", "rest_webservices"],
      tokenAuth: "basic",
      resourceUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest",
    });
    expect(getNativeOAuthProviderConfig("coupa")).toMatchObject({
      authorizationEndpoint: "https://stella.coupahost.com/oauth2/authorize",
      tokenEndpoint: "https://stella.coupahost.com/oauth2/token",
      scopes: ["core.common.read", "core.common.write"],
      resourceUrl: "https://stella.coupahost.com",
    });
    expect(getNativeOAuthProviderConfig("d2lbrightspace")).toMatchObject({
      authorizationEndpoint: "https://auth.brightspace.com/oauth2/auth",
      tokenEndpoint: "https://auth.brightspace.com/core/connect/token",
      scopes: ["core:*:*"],
      resourceUrl: "https://stella.brightspace.com",
    });
    expect(getNativeOAuthProviderConfig("blackboard")).toMatchObject({
      authorizationEndpoint:
        "https://stella.blackboard.com/learn/api/public/v1/oauth2/authorizationcode",
      tokenEndpoint:
        "https://stella.blackboard.com/learn/api/public/v1/oauth2/token",
      authorizationRedirectParam: "redirect_url",
      tokenRedirectParam: "redirect_url",
      usesPkce: true,
      tokenAuth: "basic",
      resourceUrl: "https://stella.blackboard.com/learn/api/public/v1",
    });
    expect(getNativeOAuthProviderConfig("dub")).toMatchObject({
      authorizationEndpoint: "https://app.dub.co/oauth/authorize",
      tokenEndpoint: "https://api.dub.co/oauth/token",
      scopes: [
        "links.read",
        "links.write",
        "tags.read",
        "tags.write",
        "analytics.read",
        "domains.read",
        "domains.write",
        "folders.read",
        "folders.write",
        "user.read",
      ],
      usesPkce: true,
      resourceUrl: "https://api.dub.co",
    });
    expect(getNativeOAuthProviderConfig("blackbaud")).toMatchObject({
      authorizationEndpoint: "https://oauth2.sky.blackbaud.com/authorization",
      tokenEndpoint: "https://oauth2.sky.blackbaud.com/token",
      resourceUrl: "https://api.sky.blackbaud.com",
    });
    expect(getNativeOAuthProviderConfig("exist")).toMatchObject({
      authorizationEndpoint: "https://exist.io/oauth2/authorize",
      tokenEndpoint: "https://exist.io/oauth2/access_token",
      resourceUrl: "https://exist.io/api/2",
    });
    expect(getNativeOAuthProviderConfig("omnisend")).toMatchObject({
      authorizationEndpoint: "https://app.omnisend.com/oauth2/authorize",
      tokenEndpoint: "https://app.omnisend.com/oauth2/token",
      resourceUrl: "https://api.omnisend.com",
    });
    expect(getNativeOAuthProviderConfig("ramp")).toMatchObject({
      authorizationEndpoint: "https://app.ramp.com/v1/authorize",
      tokenEndpoint: "https://api.ramp.com/developer/v1/token",
      tokenAuth: "basic",
      resourceUrl: "https://api.ramp.com/developer/v1",
    });
    expect(getNativeOAuthProviderConfig("brex")).toMatchObject({
      authorizationEndpoint:
        "https://accounts-api.brex.com/oauth2/default/v1/authorize",
      tokenEndpoint:
        "https://accounts-api.brex.com/oauth2/default/v1/token",
      tokenAuth: "basic",
      resourceUrl: "https://platform.brexapis.com",
    });
    expect(getNativeOAuthProviderConfig("workday")).toMatchObject({
      authorizationEndpoint:
        "https://wd2.workday.com/ccx/oauth2/stella/authorize",
      tokenEndpoint: "https://wd2.workday.com/ccx/oauth2/stella/token",
      tokenAuth: "basic",
      resourceUrl: "https://wd2.workday.com/ccx/api",
    });
    expect(getNativeOAuthProviderConfig("yandex")).toMatchObject({
      authorizationEndpoint: "https://oauth.yandex.com/authorize",
      tokenEndpoint: "https://oauth.yandex.com/token",
      apiAuthScheme: "oauth",
      resourceUrl: "https://cloud-api.yandex.net/v1",
    });
    expect(getNativeOAuthProviderConfig("dynamics365")).toMatchObject({
      authorizationEndpoint:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint:
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: [
        "offline_access",
        "https://stella.crm.dynamics.com/user_impersonation",
      ],
      resourceUrl: "https://stella.crm.dynamics.com",
    });
    expect(getNativeOAuthProviderConfig("kit")).toMatchObject({
      authorizationEndpoint: "https://api.kit.com/v4/oauth/authorize",
      tokenEndpoint: "https://api.kit.com/v4/oauth/token",
      usesPkce: true,
      resourceUrl: "https://api.kit.com/v4",
    });
    expect(getNativeOAuthProviderConfig("lever")).toMatchObject({
      authorizationEndpoint: "https://auth.lever.co/authorize",
      tokenEndpoint: "https://auth.lever.co/oauth/token",
      authorizationParams: {
        audience: "https://api.lever.co/v1/",
      },
      resourceUrl: "https://api.lever.co/v1",
    });
    expect(getNativeOAuthProviderConfig("linkhut")).toMatchObject({
      authorizationEndpoint: "https://ln.ht/_/oauth/authorize",
      tokenEndpoint: "https://api.ln.ht/v1/oauth/token",
      resourceUrl: "https://api.ln.ht/v1",
    });
    expect(getNativeOAuthProviderConfig("prisma")).toMatchObject({
      authorizationEndpoint: "https://auth.prisma.io/authorize",
      tokenEndpoint: "https://auth.prisma.io/token",
      usesPkce: true,
      resourceUrl: "https://api.prisma.io/v1",
    });
    expect(getNativeOAuthProviderConfig("toneden")).toMatchObject({
      authorizationEndpoint: "https://www.toneden.io/auth/oauth2/authorize",
      tokenEndpoint: "https://www.toneden.io/auth/oauth2/token",
      resourceUrl: "https://www.toneden.io/api/v1",
    });
  });

  it("still requires backend token exchange readiness for external-callback providers with secrets", async () => {
    const root = createRoot();
    for (const id of [
      "ATTIO",
      "CROWDIN",
      "EVENTBRITE",
      "FRESHBOOKS",
      "FREEAGENT",
      "GUMROAD",
      "HARVEST",
      "NOTION",
      "MIRO",
      "WAKATIME",
      "TICKTICK",
      "PUSHBULLET",
      "SPLITWISE",
      "STRIPE",
      "SUPABASE",
      "ZOOM",
      "PIPEDRIVE",
      "CALENDLY",
    ]) {
      process.env[`STELLA_NATIVE_OAUTH_${id}_CLIENT_ID`] =
        `${id.toLowerCase()}-client`;
    }

    const withoutBackend = await listNativeConnectors(root);
    expect(
      withoutBackend.find((entry) => entry.id === "notion")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "miro")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "wakatime")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "ticktick")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "pushbullet")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "attio")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "eventbrite")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "harvest")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "gumroad")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "freshbooks")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "freeagent")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "zoom")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "pipedrive")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "crowdin")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "supabase")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "splitwise")?.connectable,
    ).toBe(false);
    expect(
      withoutBackend.find((entry) => entry.id === "stripe")?.connectable,
    ).toBe(false);
    await expect(enableNativeConnector(root, "notion", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(enableNativeConnector(root, "miro", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(
      enableNativeConnector(root, "wakatime", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(
      enableNativeConnector(root, "ticktick", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(
      enableNativeConnector(root, "pushbullet", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(enableNativeConnector(root, "attio", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(
      enableNativeConnector(root, "eventbrite", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(enableNativeConnector(root, "harvest", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(enableNativeConnector(root, "gumroad", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(
      enableNativeConnector(root, "freshbooks", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(
      enableNativeConnector(root, "freeagent", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(enableNativeConnector(root, "zoom", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(
      enableNativeConnector(root, "pipedrive", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(enableNativeConnector(root, "crowdin", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );
    await expect(
      enableNativeConnector(root, "supabase", "cli"),
    ).rejects.toThrow("secure server connection is not ready");
    await expect(enableNativeConnector(root, "stripe", "cli")).rejects.toThrow(
      "secure server connection is not ready",
    );

    const withBridge = await listNativeConnectors(root, {
      configuredBackendProviders: new Set([
        "attio",
        "crowdin",
        "eventbrite",
        "freshbooks",
        "freeagent",
        "gumroad",
        "harvest",
        "notion",
        "miro",
        "wakatime",
        "ticktick",
        "pushbullet",
        "splitwise",
        "stripe",
        "supabase",
        "zoom",
        "pipedrive",
        "calendly",
      ]),
    });
    expect(withBridge.find((entry) => entry.id === "notion")?.connectable).toBe(
      true,
    );
    expect(withBridge.find((entry) => entry.id === "attio")).toMatchObject({
      connectable: true,
      actionCount: 99,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "eventbrite")).toMatchObject(
      {
        connectable: true,
        actionCount: 95,
        toolCount: 1,
      },
    );
    expect(withBridge.find((entry) => entry.id === "harvest")).toMatchObject({
      connectable: true,
      actionCount: 57,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "gumroad")).toMatchObject({
      connectable: true,
      actionCount: 7,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "freshbooks")).toMatchObject(
      {
        connectable: true,
        actionCount: 10,
        toolCount: 1,
      },
    );
    expect(withBridge.find((entry) => entry.id === "freeagent")).toMatchObject({
      connectable: true,
      actionCount: 17,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "splitwise")).toMatchObject({
      connectable: true,
      actionCount: 27,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "miro")).toMatchObject({
      connectable: true,
      actionCount: 73,
    });
    expect(withBridge.find((entry) => entry.id === "wakatime")).toMatchObject({
      connectable: true,
      actionCount: 17,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "ticktick")).toMatchObject({
      connectable: true,
      actionCount: 13,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "pushbullet")).toMatchObject(
      {
        connectable: true,
        actionCount: 15,
        toolCount: 1,
      },
    );
    expect(withBridge.find((entry) => entry.id === "calendly")).toMatchObject({
      connectable: true,
      actionCount: 51,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "zoom")).toMatchObject({
      connectable: true,
      actionCount: 89,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "pipedrive")).toMatchObject({
      connectable: true,
      actionCount: 398,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "crowdin")).toMatchObject({
      connectable: true,
      actionCount: 230,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "supabase")).toMatchObject({
      connectable: true,
      actionCount: 119,
      toolCount: 1,
    });
    expect(withBridge.find((entry) => entry.id === "stripe")).toMatchObject({
      connectable: true,
      actionCount: 415,
      toolCount: 1,
    });
  });

  it("lets one shared OAuth app unlock provider families", async () => {
    const root = createRoot();

    process.env.STELLA_NATIVE_OAUTH_MICROSOFT_CLIENT_ID = "microsoft-client-id";
    process.env.STELLA_NATIVE_OAUTH_ATLASSIAN_CLIENT_ID = "atlassian-client-id";
    process.env.STELLA_NATIVE_OAUTH_ZOHO_CLIENT_ID = "zoho-client-id";
    process.env.STELLA_NATIVE_OAUTH_SALESFORCE_CLIENT_ID =
      "salesforce-client-id";

    const connectors = await listNativeConnectors(root, {
      configuredBackendProviders: new Set(["atlassian", "salesforce", "zoho"]),
    });

    for (const id of ["excel", "one_drive", "outlook", "share_point"]) {
      expect(connectors.find((entry) => entry.id === id)).toMatchObject({
        connectable: true,
        oauthSetupStatus: "ready",
        toolCount: 1,
      });
    }

    for (const id of ["confluence", "jira"]) {
      expect(connectors.find((entry) => entry.id === id)).toMatchObject({
        connectable: true,
        oauthSetupStatus: "ready",
        toolCount: 1,
      });
    }

    for (const id of [
      "zoho",
      "zoho_bigin",
      "zoho_books",
      "zoho_desk",
      "zoho_inventory",
      "zoho_invoice",
      "zoho_mail",
    ]) {
      expect(connectors.find((entry) => entry.id === id)).toMatchObject({
        connectable: true,
        oauthSetupStatus: "ready",
        toolCount: 1,
      });
    }

    for (const id of ["salesforce", "salesforce_service_cloud"]) {
      expect(connectors.find((entry) => entry.id === id)).toMatchObject({
        connectable: true,
        oauthSetupStatus: "ready",
        oauthSetupGroup: {
          id: "salesforce",
          name: "Salesforce",
        },
        toolCount: 1,
      });
    }

    await expect(
      enableNativeConnector(root, "outlook", "cli"),
    ).resolves.toMatchObject({
      id: "outlook",
      enabled: true,
    });
    await expect(
      enableNativeConnector(root, "jira", "cli", {
        configuredBackendProviders: new Set(["atlassian"]),
      }),
    ).resolves.toMatchObject({
      id: "jira",
      enabled: true,
    });
    await expect(
      enableNativeConnector(root, "salesforce_service_cloud", "cli", {
        configuredBackendProviders: new Set(["salesforce"]),
      }),
    ).resolves.toMatchObject({
      id: "salesforce_service_cloud",
      enabled: true,
    });
  });

  it("honors shared provider backend readiness environment flags", async () => {
    const root = createRoot();

    process.env.STELLA_NATIVE_OAUTH_ATLASSIAN_CLIENT_ID = "atlassian-client-id";
    process.env.STELLA_NATIVE_OAUTH_ATLASSIAN_BACKEND_READY = "1";

    const connectors = await listNativeConnectors(root);

    expect(connectors.find((entry) => entry.id === "jira")).toMatchObject({
      connectable: true,
      oauthSetupStatus: "ready",
    });
    expect(connectors.find((entry) => entry.id === "confluence")).toMatchObject(
      {
        connectable: true,
        oauthSetupStatus: "ready",
      },
    );
    await expect(
      enableNativeConnector(root, "jira", "cli"),
    ).resolves.toMatchObject({
      id: "jira",
      enabled: true,
    });
  });
});
