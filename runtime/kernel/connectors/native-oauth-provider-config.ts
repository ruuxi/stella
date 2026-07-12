export type NativeOAuthProviderConfig = {
  tokenKey: string;
  clientId: string;
  tokenEndpoint?: string;
  scopes?: string[];
  resourceUrl?: string;
  apiQueryParams?: Record<string, string>;
  apiAuthPlacement?: "authorization_header" | "access_token_query";
  apiAuthScheme?: "bearer" | "basic" | "oauth" | "raw";
  oauthResource?: string | null;
  usesPkce?: boolean;
  authorizationClientIdParam?: string;
  authorizationRedirectParam?: string;
  authorizationParams?: Record<string, string>;
  tokenRedirectParam?: string;
  tokenAuth?: "body" | "basic";
  tokenExchange?: {
    type: "direct" | "backend";
    provider?: string;
  };
} & (
  | {
      flow: "authorization_code";
      authorizationEndpoint: string;
      responseType?: "code" | "token";
      callbackId: string;
      callbackUrl?: string;
      callbackMode?: "local" | "external";
      scopeSeparator?: string;
    }
  | {
      flow: "device";
      deviceAuthorizationEndpoint: string;
      verificationUri?: string;
    }
);

export type NativeOAuthProviderConfigOptions = {
  configuredBackendProviders?: ReadonlySet<string>;
  configuredExternalCallbackProviders?: ReadonlySet<string>;
};

const envKey = (id: string, suffix: string) =>
  `STELLA_NATIVE_OAUTH_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;

const DEFAULT_CALLBACK_URL =
  process.env.STELLA_NATIVE_OAUTH_CALLBACK_URL?.trim() ||
  "http://127.0.0.1:48743/callback";

const isHostedOAuthCallbackUrl = (value?: string) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "stella.sh" &&
      /^\/oauth\/[a-z0-9_-]+\/callback$/iu.test(parsed.pathname)
    );
  } catch {
    return false;
  }
};

const readEnvList = (key: string) =>
  process.env[key]
    ?.split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

const readEnvJsonObject = (key: string) => {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entries = Object.entries(parsed).flatMap(([entryKey, value]) => {
      if (typeof value !== "string") return [];
      const trimmedKey = entryKey.trim();
      const trimmedValue = value.trim();
      return trimmedKey && trimmedValue
        ? ([[trimmedKey, trimmedValue]] as const)
        : [];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
};

const readEnvUsesPkce = (id: string) => {
  const value = process.env[envKey(id, "USES_PKCE")]?.trim().toLowerCase();
  if (!value) return undefined;
  return !["0", "false", "no", "off"].includes(value);
};

const readEnvTokenAuth = (id: string) =>
  process.env[envKey(id, "TOKEN_AUTH")] === "basic"
    ? ("basic" as const)
    : undefined;

const readEnvTokenExchange = (
  id: string,
  fallback?: NativeOAuthProviderConfig["tokenExchange"],
) => {
  const value = process.env[envKey(id, "TOKEN_EXCHANGE")]?.trim().toLowerCase();
  if (value === "backend") {
    return {
      type: "backend" as const,
      provider:
        process.env[envKey(id, "TOKEN_EXCHANGE_PROVIDER")]?.trim() ||
        fallback?.provider ||
        id.trim().toLowerCase(),
    };
  }
  if (value === "direct") return { type: "direct" as const };
  return fallback;
};

const readEnvCallbackUrl = (id: string, fallback: string) =>
  process.env[envKey(id, "CALLBACK_URL")]?.trim() || fallback;

const readEnvClientId = (id: string) =>
  process.env[envKey(id, "CLIENT_ID")]?.trim();

export const hasNativeOAuthProviderClientIdOverride = (id: string) =>
  Boolean(readEnvClientId(id));

const readEnvScopesOrDefault = (id: string, fallback: string[]) => {
  const scopes = readEnvList(envKey(id, "SCOPES"));
  return scopes?.length ? scopes : fallback;
};

const mergeAuthorizationParams = (
  id: string,
  fallback?: Record<string, string>,
) => ({
  ...(fallback ?? {}),
  ...(readEnvJsonObject(envKey(id, "AUTHORIZATION_PARAMS_JSON")) ?? {}),
});

const applyEnvOverrides = (
  id: string,
  config: NativeOAuthProviderConfig,
): NativeOAuthProviderConfig => {
  const clientId = process.env[envKey(id, "CLIENT_ID")]?.trim();
  const scopes = readEnvList(envKey(id, "SCOPES"));
  const resourceUrl = process.env[envKey(id, "RESOURCE_URL")]?.trim();
  const tokenEndpoint =
    process.env[envKey(id, "TOKEN_URL")]?.trim() ||
    process.env[envKey(id, "TOKEN_ENDPOINT")]?.trim();
  const tokenAuth = readEnvTokenAuth(id);
  const usesPkce = readEnvUsesPkce(id);
  const common = {
    ...config,
    clientId: clientId || config.clientId,
    tokenEndpoint: tokenEndpoint || config.tokenEndpoint,
    scopes: scopes?.length ? scopes : config.scopes,
    resourceUrl: resourceUrl || config.resourceUrl,
    apiQueryParams:
      readEnvJsonObject(envKey(id, "API_QUERY_PARAMS_JSON")) ??
      config.apiQueryParams,
    apiAuthPlacement:
      process.env[envKey(id, "API_AUTH_PLACEMENT")] === "access_token_query"
        ? ("access_token_query" as const)
        : config.apiAuthPlacement,
    apiAuthScheme:
      process.env[envKey(id, "API_AUTH_SCHEME")] === "basic" ||
      process.env[envKey(id, "API_AUTH_SCHEME")] === "oauth" ||
      process.env[envKey(id, "API_AUTH_SCHEME")] === "raw"
        ? (process.env[envKey(id, "API_AUTH_SCHEME")] as
            | "basic"
            | "oauth"
            | "raw")
        : config.apiAuthScheme,
    usesPkce: usesPkce ?? config.usesPkce,
    authorizationRedirectParam:
      process.env[envKey(id, "AUTHORIZATION_REDIRECT_PARAM")]?.trim() ||
      config.authorizationRedirectParam,
    authorizationParams: mergeAuthorizationParams(
      id,
      config.authorizationParams,
    ),
    tokenRedirectParam:
      process.env[envKey(id, "TOKEN_REDIRECT_PARAM")]?.trim() ||
      config.tokenRedirectParam,
    tokenAuth: tokenAuth ?? config.tokenAuth,
    tokenExchange: readEnvTokenExchange(id, config.tokenExchange),
  };

  if (common.flow === "device") {
    return {
      ...common,
      deviceAuthorizationEndpoint:
        process.env[envKey(id, "DEVICE_AUTHORIZATION_URL")]?.trim() ||
        common.deviceAuthorizationEndpoint,
      verificationUri:
        process.env[envKey(id, "VERIFICATION_URL")]?.trim() ||
        common.verificationUri,
    };
  }

  return {
    ...common,
    authorizationEndpoint:
      process.env[envKey(id, "AUTHORIZATION_URL")]?.trim() ||
      common.authorizationEndpoint,
    callbackId:
      process.env[envKey(id, "CALLBACK_ID")]?.trim() || common.callbackId,
    callbackUrl: readEnvCallbackUrl(
      id,
      common.callbackUrl ?? DEFAULT_CALLBACK_URL,
    ),
    callbackMode:
      process.env[envKey(id, "CALLBACK_MODE")] === "external"
        ? "external"
        : process.env[envKey(id, "CALLBACK_MODE")] === "local"
          ? "local"
          : common.callbackMode,
    scopeSeparator:
      process.env[envKey(id, "SCOPE_SEPARATOR")] || common.scopeSeparator,
    responseType:
      process.env[envKey(id, "RESPONSE_TYPE")] === "token"
        ? "token"
        : common.responseType,
  };
};

const MICROSOFT_GRAPH_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Files.ReadWrite.All",
  "Sites.ReadWrite.All",
];

const MICROSOFT_GRAPH_ALIASES = new Set([
  "excel",
  "one_drive",
  "outlook",
  "share_point",
]);

const META_GRAPH_VERSION =
  process.env.STELLA_NATIVE_OAUTH_META_GRAPH_VERSION?.trim() || "v23.0";

const META_SCOPES = [
  "public_profile",
  "email",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "ads_read",
  "ads_management",
  "business_management",
];

const META_ALIASES = new Set(["facebook", "instagram", "metaads"]);

const ATLASSIAN_SCOPES = [
  "offline_access",
  "read:me",
  "read:jira-user",
  "read:jira-work",
  "write:jira-work",
  "manage:jira-project",
  "read:confluence-content.all",
  "write:confluence-content",
  "search:confluence",
];

const ATLASSIAN_ALIASES = new Set(["confluence", "jira"]);

const ZOHO_SCOPES = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoBigin.modules.ALL",
  "ZohoBooks.fullaccess.all",
  "ZohoInvoice.invoices.ALL",
  "ZohoInventory.FullAccess.all",
  "Desk.basic.READ",
  "Desk.tickets.ALL",
  "Desk.settings.ALL",
  "ZohoMail.messages.ALL",
  "ZohoMail.accounts.READ",
];

const ZOHO_ALIASES: Record<string, string> = {
  zoho: "https://www.zohoapis.com",
  zoho_bigin: "https://www.zohoapis.com/bigin/v2",
  zoho_books: "https://www.zohoapis.com/books/v3",
  zoho_desk: "https://desk.zoho.com/api/v1",
  zoho_inventory: "https://www.zohoapis.com/inventory/v1",
  zoho_invoice: "https://www.zohoapis.com/invoice/v3",
  zoho_mail: "https://mail.zoho.com/api",
};

const SALESFORCE_SCOPES = ["api", "refresh_token"];
const SALESFORCE_ALIASES = new Set(["salesforce", "salesforce_service_cloud"]);

const SPOTIFY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-follow-read",
  "user-follow-modify",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
];

const DROPBOX_SCOPES = [
  "account_info.read",
  "files.content.read",
  "files.content.write",
  "files.metadata.read",
  "files.metadata.write",
  "sharing.read",
  "sharing.write",
];

const GITLAB_SCOPES = [
  "api",
  "read_user",
  "read_api",
  "read_repository",
  "write_repository",
];
const BITBUCKET_SCOPES = [
  "account",
  "email",
  "repository",
  "repository:write",
  "pullrequest",
  "pullrequest:write",
  "issue",
  "issue:write",
  "webhook",
  "wiki",
  "snippet",
];
const BOX_SCOPES = ["root_readwrite"];
const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "tickets",
];
const MAILCHIMP_SCOPES = [
  "campaigns:read",
  "campaigns:write",
  "lists:read",
  "lists:write",
  "reports:read",
];
const CLICKUP_SCOPES = [
  "task:read",
  "task:write",
  "team:read",
  "space:read",
  "folder:read",
  "list:read",
];
const WEBFLOW_SCOPES = [
  "sites:read",
  "sites:write",
  "cms:read",
  "cms:write",
  "forms:read",
  "forms:write",
  "assets:read",
  "assets:write",
];
const REDDIT_SCOPES = [
  "identity",
  "read",
  "submit",
  "edit",
  "history",
  "save",
  "vote",
  "mysubreddits",
  "flair",
];
const QUICKBOOKS_SCOPES = [
  "com.intuit.quickbooks.accounting",
  "openid",
  "profile",
  "email",
];
const XERO_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "accounting.transactions",
  "accounting.contacts",
  "accounting.settings",
  "accounting.attachments",
];
const ZENDESK_SCOPES = ["read", "write"];
const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"];
const SHOPIFY_SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "write_orders",
  "read_customers",
  "write_customers",
  "read_inventory",
  "write_inventory",
  "read_content",
  "write_content",
];
const SQUARE_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "ITEMS_READ",
  "ITEMS_WRITE",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
];
const STRAVA_SCOPES = [
  "read",
  "read_all",
  "profile:read_all",
  "activity:read",
  "activity:read_all",
  "activity:write",
];
const SURVEY_MONKEY_SCOPES = [
  "view_survey",
  "edit_survey",
  "collect_responses",
  "view_collectors",
  "view_responses",
  "view_user",
];
const DOCUSIGN_SCOPES = ["signature", "impersonation"];
const DIGITAL_OCEAN_SCOPES = [
  "account:read",
  "droplet:read",
  "droplet:create",
  "droplet:update",
  "project:read",
  "project:create",
  "project:update",
  "image:read",
  "volume:read",
  "reserved_ip:read",
  "registry:read",
  "registry:update",
];
const MURAL_SCOPES = [
  "workspaces:read",
  "murals:read",
  "murals:write",
  "rooms:read",
  "rooms:write",
  "templates:read",
];
const CANVAS_SCOPES = ["/auth/userinfo"];
const DATADOG_SCOPES = ["user_access:read", "user_access:write"];
const WRIKE_SCOPES = ["Default", "wsReadWrite"];
const INTERCOM_SCOPES = [
  "read_conversations",
  "write_conversations",
  "read_contacts",
  "write_contacts",
  "read_companies",
  "write_companies",
  "read_admins",
];
const KLAVIYO_SCOPES = [
  "campaigns:read",
  "campaigns:write",
  "catalogs:read",
  "catalogs:write",
  "events:read",
  "events:write",
  "lists:read",
  "lists:write",
  "metrics:read",
  "profiles:read",
  "profiles:write",
  "segments:read",
  "segments:write",
  "templates:read",
  "templates:write",
];
const BREVO_SCOPES = ["all"];
const YNAB_SCOPES: string[] = [];
const WEBEX_SCOPES = [
  "spark:all",
  "spark:rooms_read",
  "spark:rooms_write",
  "spark:messages_read",
  "spark:messages_write",
  "spark:memberships_read",
  "spark:memberships_write",
  "spark:people_read",
];
const PRODUCTBOARD_SCOPES = ["read", "write"];
const GORGIAS_SCOPES = ["openid", "email", "profile"];
const CANVA_SCOPES = [
  "asset:read",
  "asset:write",
  "design:meta:read",
  "design:content:read",
  "design:content:write",
  "design:permission:read",
  "folder:read",
  "folder:write",
  "profile:read",
];
const BAMBOOHR_SCOPES = ["openid", "email", "profile", "offline_access"];
const X_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
  "follows.read",
  "follows.write",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
];
const TIKTOK_SCOPES = ["user.info.basic", "video.list", "video.upload"];
const DROPBOX_SIGN_SCOPES = ["basic_account_info", "request_signature"];
const STORYBLOK_SCOPES = ["read_content", "write_content"];
const SHIPPO_SCOPES = ["*"];
const BOLDSIGN_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "BoldSign.Documents.All",
  "BoldSign.Templates.All",
  "BoldSign.Users.Read",
];
const FOLLOW_UP_BOSS_SCOPES: string[] = [];
const MONEYBIRD_SCOPES = [
  "sales_invoices",
  "documents",
  "estimates",
  "bank",
  "time_entries",
  "settings",
];
const WORKABLE_SCOPES = ["r_jobs", "r_candidates", "w_candidates"];
const BASECAMP_SCOPES: string[] = [];
const BEEMINDER_SCOPES: string[] = [];
const FLY_SCOPES = ["read"];
const FATHOM_SCOPES = ["public_api"];
const HUGGING_FACE_SCOPES = [
  "openid",
  "profile",
  "email",
  "read-repos",
  "inference-api",
];
const WHOP_SCOPES = ["openid", "profile", "email"];
const XATA_SCOPES = ["admin:all"];
const PAGERDUTY_SCOPES = [
  "openid",
  "incidents.read",
  "incidents.write",
  "services.read",
  "users.read",
  "schedules.read",
  "escalation_policies.read",
  "abilities.read",
];
const CONTENTFUL_SCOPES = ["content_management_manage"];
const DATABRICKS_SCOPES = ["all-apis", "offline_access"];
const EGNYTE_SCOPES = [
  "Egnyte.filesystem",
  "Egnyte.user",
  "Egnyte.group",
  "Egnyte.link",
  "Egnyte.permission",
  "Egnyte.bookmark",
  "Egnyte.launchwebsession",
];
const APALEO_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "availability.read",
  "rates.read",
  "reservations.read",
  "reservations.create",
  "properties.read",
];
const DIALPAD_SCOPES = [
  "offline_access",
  "calls:list",
  "recordings_export",
  "message_content_export",
  "screen_pop",
  "fax_message",
  "change_log",
];
const SERVICEM8_SCOPES = [
  "vendor",
  "vendor_email",
  "read_staff",
  "read_customers",
  "read_jobs",
  "manage_jobs",
  "read_schedule",
  "read_tasks",
  "read_inventory",
  "read_job_notes",
  "publish_job_notes",
];
const TIMELY_SCOPES: string[] = [];
const KOMMO_SCOPES: string[] = [];
const GONG_SCOPES: string[] = [];
const SNOWFLAKE_SCOPES = ["session:role-any"];
const NETSUITE_SCOPES = ["restlets", "rest_webservices"];
const COUPA_SCOPES = ["core.common.read", "core.common.write"];
const D2L_BRIGHTSPACE_SCOPES = ["core:*:*"];
const BLACKBOARD_SCOPES: string[] = [];
const DUB_SCOPES = [
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
];
const BLACKBAUD_SCOPES: string[] = [];
const EXIST_SCOPES = [
  "activity_read",
  "activity_write",
  "productivity_read",
  "productivity_write",
  "mood_read",
  "mood_write",
  "sleep_read",
  "sleep_write",
  "workouts_read",
  "workouts_write",
  "events_read",
  "events_write",
  "finance_read",
  "finance_write",
  "food_read",
  "food_write",
  "health_read",
  "health_write",
  "location_read",
  "location_write",
  "media_read",
  "media_write",
  "social_read",
  "social_write",
  "weather_read",
  "weather_write",
  "symptoms_read",
  "symptoms_write",
  "medication_read",
  "medication_write",
  "custom_read",
  "custom_write",
  "manual_read",
  "manual_write",
];
const OMNISEND_SCOPES = [
  "contacts.read",
  "contacts.write",
  "products.read",
  "products.write",
  "orders.read",
  "orders.write",
  "carts.read",
  "carts.write",
  "events.read",
  "events.write",
  "campaigns.read",
  "campaigns.write",
  "batches.write",
];
const RAMP_SCOPES = [
  "business:read",
  "business:write",
  "transactions:read",
  "cards:read",
  "cards:write",
  "users:read",
  "users:write",
  "departments:read",
  "departments:write",
  "reimbursements:read",
  "reimbursements:write",
  "vendors:read",
  "vendors:write",
  "accounting:read",
  "accounting:write",
];
const BREX_SCOPES = [
  "openid",
  "offline_access",
  "users.card.readonly",
  "cards.readonly",
  "cards",
  "transactions.card.readonly",
  "accounts.cash.readonly",
  "vendors.readonly",
  "expenses.card.readonly",
  "budgets.readonly",
];
const WORKDAY_SCOPES: string[] = [];
const YANDEX_SCOPES: string[] = [];
const DYNAMICS365_SCOPES = ["offline_access"];
const KIT_SCOPES = [
  "public",
  "read_subscribers",
  "write_subscribers",
  "write_forms",
  "write_tags",
];
const LEVER_SCOPES = [
  "offline_access",
  "applications:read:admin",
  "candidates:read:admin",
  "opportunities:read:admin",
  "postings:read:admin",
  "requisitions:read:admin",
];
const LINKHUT_SCOPES = ["posts:read", "posts:write", "tags:read", "tags:write"];
const PRISMA_SCOPES = ["workspace:admin", "offline_access"];
const TONEDEN_SCOPES: string[] = [];

const ENV_BACKED_NATIVE_OAUTH_PROVIDER_IDS = new Set([
  "spotify",
  "dropbox",
  "gitlab",
  "bitbucket",
  "box",
  "hubspot",
  "mailchimp",
  "clickup",
  "webflow",
  "reddit",
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
  "twitter",
  "tiktok",
  "dropbox_sign",
  "storyblok",
  "shippo",
  "boldsign",
  "follow_up_boss",
  "moneybird",
  "workable",
  "basecamp",
  "beeminder",
  "fly",
  "fathom",
  "hugging_face",
  "whop",
  "xata",
  "pagerduty",
  "contentful",
  "databricks",
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
]);

const SHARED_OAUTH_PROVIDER_SETUP_GROUPS: Record<
  string,
  { id: string; name: string }
> = Object.fromEntries([
  ...[...MICROSOFT_GRAPH_ALIASES].map(
    (id) => [id, { id: "microsoft", name: "Microsoft" }] as const,
  ),
  ...[...META_ALIASES].map((id) => [id, { id: "meta", name: "Meta" }] as const),
  ...[...ATLASSIAN_ALIASES].map(
    (id) => [id, { id: "atlassian", name: "Atlassian" }] as const,
  ),
  ...Object.keys(ZOHO_ALIASES).map(
    (id) => [id, { id: "zoho", name: "Zoho" }] as const,
  ),
  ...[...SALESFORCE_ALIASES].map(
    (id) => [id, { id: "salesforce", name: "Salesforce" }] as const,
  ),
]);

export const getNativeOAuthProviderSetupGroup = (id: string) =>
  SHARED_OAUTH_PROVIDER_SETUP_GROUPS[id.trim().toLowerCase()];

export const hasNativeOAuthProviderTemplate = (id: string) => {
  const normalizedId = id.trim().toLowerCase();
  return (
    normalizedId in BUILTIN_NATIVE_OAUTH ||
    ENV_BACKED_NATIVE_OAUTH_PROVIDER_IDS.has(normalizedId) ||
    normalizedId in SHARED_OAUTH_PROVIDER_SETUP_GROUPS
  );
};

/**
 * Affirmative, reviewed policy for generic OAuth-catalog dispatchers. Empty by
 * design today: the shipped local integrations are the separately enumerated
 * Google Workspace entries in native-integrations.ts. Adding a template or
 * OAuth config must never activate execution without a deliberate allowlist
 * change here.
 */
const PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS = new Set<string>([]);

export const isNativeOAuthLocalExecutionProductionReady = (id: string) =>
  PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS.has(id.trim().toLowerCase());

const readSharedOAuthProviderConfig = (
  id: string,
): NativeOAuthProviderConfig | null => {
  if (MICROSOFT_GRAPH_ALIASES.has(id)) {
    const clientId = process.env[envKey("microsoft", "CLIENT_ID")]?.trim();
    if (!clientId) return null;
    return {
      flow: "authorization_code",
      tokenKey: "native-oauth:microsoft",
      clientId,
      authorizationEndpoint:
        process.env[envKey("microsoft", "AUTHORIZATION_URL")]?.trim() ||
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint:
        process.env[envKey("microsoft", "TOKEN_URL")]?.trim() ||
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      callbackId: "microsoft",
      callbackUrl: readEnvCallbackUrl(
        "microsoft",
        "https://stella.sh/oauth/microsoft/callback",
      ),
      callbackMode: "external",
      scopes: readEnvScopesOrDefault("microsoft", MICROSOFT_GRAPH_SCOPES),
      usesPkce: readEnvUsesPkce("microsoft") ?? true,
      resourceUrl: "https://graph.microsoft.com/v1.0",
    };
  }

  if (META_ALIASES.has(id)) {
    const clientId = process.env[envKey("meta", "CLIENT_ID")]?.trim();
    if (!clientId) return null;
    return {
      flow: "authorization_code",
      tokenKey: "native-oauth:meta",
      clientId,
      authorizationEndpoint:
        process.env[envKey("meta", "AUTHORIZATION_URL")]?.trim() ||
        `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
      tokenEndpoint:
        process.env[envKey("meta", "TOKEN_URL")]?.trim() ||
        `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`,
      callbackId: "meta",
      callbackUrl: readEnvCallbackUrl(
        "meta",
        "https://stella.sh/oauth/meta/callback",
      ),
      callbackMode: "external",
      scopes: readEnvScopesOrDefault("meta", META_SCOPES),
      scopeSeparator: ",",
      resourceUrl:
        process.env[envKey(id, "RESOURCE_URL")]?.trim() ||
        `https://graph.facebook.com/${META_GRAPH_VERSION}`,
      tokenExchange: { type: "backend", provider: "meta" },
    };
  }

  if (ATLASSIAN_ALIASES.has(id)) {
    const clientId =
      process.env[envKey("atlassian", "CLIENT_ID")]?.trim() ||
      "O4JACV7CNnTz26pYwIUirYSWrEed4Q7g";
    if (!clientId) return null;
    return {
      flow: "authorization_code",
      tokenKey: "native-oauth:atlassian",
      clientId,
      authorizationEndpoint:
        process.env[envKey("atlassian", "AUTHORIZATION_URL")]?.trim() ||
        "https://auth.atlassian.com/authorize",
      tokenEndpoint:
        process.env[envKey("atlassian", "TOKEN_URL")]?.trim() ||
        "https://auth.atlassian.com/oauth/token",
      callbackId: "atlassian",
      callbackUrl: readEnvCallbackUrl(
        "atlassian",
        "https://stella.sh/oauth/atlassian/callback",
      ),
      callbackMode: "external",
      scopes: readEnvScopesOrDefault("atlassian", ATLASSIAN_SCOPES),
      authorizationParams: mergeAuthorizationParams("atlassian", {
        audience: "api.atlassian.com",
        prompt: "consent",
      }),
      resourceUrl: "https://api.atlassian.com",
      tokenExchange: { type: "backend", provider: "atlassian" },
    };
  }

  const zohoResourceUrl = ZOHO_ALIASES[id];
  if (zohoResourceUrl) {
    const clientId = process.env[envKey("zoho", "CLIENT_ID")]?.trim();
    if (!clientId) return null;
    return {
      flow: "authorization_code",
      tokenKey: "native-oauth:zoho",
      clientId,
      authorizationEndpoint:
        process.env[envKey("zoho", "AUTHORIZATION_URL")]?.trim() ||
        "https://accounts.zoho.com/oauth/v2/auth",
      tokenEndpoint:
        process.env[envKey("zoho", "TOKEN_URL")]?.trim() ||
        "https://accounts.zoho.com/oauth/v2/token",
      callbackId: "zoho",
      callbackUrl: readEnvCallbackUrl(
        "zoho",
        "https://stella.sh/oauth/zoho/callback",
      ),
      callbackMode: "external",
      scopes: readEnvScopesOrDefault("zoho", ZOHO_SCOPES),
      scopeSeparator: ",",
      authorizationParams: mergeAuthorizationParams("zoho", {
        access_type: "offline",
        prompt: "consent",
      }),
      resourceUrl:
        process.env[envKey(id, "RESOURCE_URL")]?.trim() || zohoResourceUrl,
      tokenExchange: { type: "backend", provider: "zoho" },
    };
  }

  if (SALESFORCE_ALIASES.has(id)) {
    const clientId = process.env[envKey("salesforce", "CLIENT_ID")]?.trim();
    if (!clientId) return null;
    const loginHost =
      process.env[envKey("salesforce", "LOGIN_URL")]?.trim() ||
      "https://login.salesforce.com";
    return {
      flow: "authorization_code",
      tokenKey: "native-oauth:salesforce",
      clientId,
      authorizationEndpoint:
        process.env[envKey("salesforce", "AUTHORIZATION_URL")]?.trim() ||
        `${loginHost}/services/oauth2/authorize`,
      tokenEndpoint:
        process.env[envKey("salesforce", "TOKEN_URL")]?.trim() ||
        `${loginHost}/services/oauth2/token`,
      callbackId: "salesforce",
      callbackUrl: readEnvCallbackUrl(
        "salesforce",
        "https://stella.sh/oauth/salesforce/callback",
      ),
      callbackMode: "external",
      scopes: readEnvScopesOrDefault("salesforce", SALESFORCE_SCOPES),
      resourceUrl:
        process.env[envKey(id, "RESOURCE_URL")]?.trim() ||
        process.env[envKey("salesforce", "RESOURCE_URL")]?.trim() ||
        loginHost,
      tokenExchange: { type: "backend", provider: "salesforce" },
    };
  }

  return null;
};

const readEnvBackedOAuthProviderConfig = (
  id: string,
): NativeOAuthProviderConfig | null => {
  const clientId = readEnvClientId(id);
  if (!clientId) return null;
  switch (id) {
    case "spotify":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:spotify",
        clientId,
        authorizationEndpoint: "https://accounts.spotify.com/authorize",
        tokenEndpoint: "https://accounts.spotify.com/api/token",
        callbackId: "spotify",
        callbackUrl: readEnvCallbackUrl("spotify", DEFAULT_CALLBACK_URL),
        scopes: readEnvScopesOrDefault("spotify", SPOTIFY_SCOPES),
        usesPkce: readEnvUsesPkce("spotify") ?? true,
        resourceUrl: "https://api.spotify.com/v1",
      };
    case "dropbox":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:dropbox",
        clientId,
        authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
        tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
        callbackId: "dropbox",
        callbackUrl: readEnvCallbackUrl("dropbox", DEFAULT_CALLBACK_URL),
        scopes: readEnvScopesOrDefault("dropbox", DROPBOX_SCOPES),
        usesPkce: readEnvUsesPkce("dropbox") ?? true,
        authorizationParams: mergeAuthorizationParams("dropbox", {
          token_access_type: "offline",
        }),
        resourceUrl: "https://api.dropboxapi.com/2",
      };
    case "gitlab":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:gitlab",
        clientId,
        authorizationEndpoint:
          process.env[envKey("gitlab", "AUTHORIZATION_URL")]?.trim() ||
          "https://gitlab.com/oauth/authorize",
        tokenEndpoint:
          process.env[envKey("gitlab", "TOKEN_URL")]?.trim() ||
          "https://gitlab.com/oauth/token",
        callbackId: "gitlab",
        callbackUrl: readEnvCallbackUrl("gitlab", DEFAULT_CALLBACK_URL),
        scopes: readEnvScopesOrDefault("gitlab", GITLAB_SCOPES),
        usesPkce: readEnvUsesPkce("gitlab") ?? true,
        resourceUrl:
          process.env[envKey("gitlab", "RESOURCE_URL")]?.trim() ||
          "https://gitlab.com/api/v4",
      };
    case "bitbucket":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:bitbucket",
        clientId,
        authorizationEndpoint: "https://bitbucket.org/site/oauth2/authorize",
        tokenEndpoint: "https://bitbucket.org/site/oauth2/access_token",
        callbackId: "bitbucket",
        callbackUrl: readEnvCallbackUrl(
          "bitbucket",
          "https://stella.sh/oauth/bitbucket/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("bitbucket", BITBUCKET_SCOPES),
        resourceUrl: "https://api.bitbucket.org/2.0",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "bitbucket" },
      };
    case "box":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:box",
        clientId,
        authorizationEndpoint: "https://account.box.com/api/oauth2/authorize",
        tokenEndpoint: "https://api.box.com/oauth2/token",
        callbackId: "box",
        callbackUrl: readEnvCallbackUrl(
          "box",
          "https://stella.sh/oauth/box/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("box", BOX_SCOPES),
        resourceUrl: "https://api.box.com/2.0",
        tokenExchange: { type: "backend", provider: "box" },
      };
    case "hubspot":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:hubspot",
        clientId,
        authorizationEndpoint: "https://app.hubspot.com/oauth/authorize",
        tokenEndpoint: "https://api.hubapi.com/oauth/v3/token",
        callbackId: "hubspot",
        callbackUrl: readEnvCallbackUrl(
          "hubspot",
          "https://stella.sh/oauth/hubspot/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("hubspot", HUBSPOT_SCOPES),
        resourceUrl: "https://api.hubapi.com",
        tokenExchange: { type: "backend", provider: "hubspot" },
      };
    case "mailchimp":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:mailchimp",
        clientId,
        authorizationEndpoint: "https://login.mailchimp.com/oauth2/authorize",
        tokenEndpoint: "https://login.mailchimp.com/oauth2/token",
        callbackId: "mailchimp",
        callbackUrl: readEnvCallbackUrl(
          "mailchimp",
          "https://stella.sh/oauth/mailchimp/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("mailchimp", MAILCHIMP_SCOPES),
        resourceUrl: "https://login.mailchimp.com/oauth2",
        tokenExchange: { type: "backend", provider: "mailchimp" },
      };
    case "clickup":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:clickup",
        clientId,
        authorizationEndpoint: "https://app.clickup.com/api",
        tokenEndpoint: "https://api.clickup.com/api/v2/oauth/token",
        callbackId: "clickup",
        callbackUrl: readEnvCallbackUrl(
          "clickup",
          "https://stella.sh/oauth/clickup/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("clickup", CLICKUP_SCOPES),
        resourceUrl: "https://api.clickup.com/api/v2",
        tokenExchange: { type: "backend", provider: "clickup" },
      };
    case "webflow":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:webflow",
        clientId,
        authorizationEndpoint: "https://webflow.com/oauth/authorize",
        tokenEndpoint: "https://api.webflow.com/oauth/access_token",
        callbackId: "webflow",
        callbackUrl: readEnvCallbackUrl(
          "webflow",
          "https://stella.sh/oauth/webflow/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("webflow", WEBFLOW_SCOPES),
        resourceUrl: "https://api.webflow.com/v2",
        tokenExchange: { type: "backend", provider: "webflow" },
      };
    case "reddit":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:reddit",
        clientId,
        authorizationEndpoint: "https://www.reddit.com/api/v1/authorize",
        tokenEndpoint: "https://www.reddit.com/api/v1/access_token",
        callbackId: "reddit",
        callbackUrl: readEnvCallbackUrl("reddit", DEFAULT_CALLBACK_URL),
        scopes: readEnvScopesOrDefault("reddit", REDDIT_SCOPES),
        usesPkce: false,
        authorizationParams: mergeAuthorizationParams("reddit", {
          duration: "permanent",
        }),
        resourceUrl: "https://oauth.reddit.com",
        tokenAuth: "basic",
      };
    case "quickbooks":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:quickbooks",
        clientId,
        authorizationEndpoint:
          process.env[envKey("quickbooks", "AUTHORIZATION_URL")]?.trim() ||
          "https://appcenter.intuit.com/connect/oauth2",
        tokenEndpoint:
          process.env[envKey("quickbooks", "TOKEN_URL")]?.trim() ||
          "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        callbackId: "quickbooks",
        callbackUrl: readEnvCallbackUrl(
          "quickbooks",
          "https://stella.sh/oauth/quickbooks/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("quickbooks", QUICKBOOKS_SCOPES),
        resourceUrl:
          process.env[envKey("quickbooks", "RESOURCE_URL")]?.trim() ||
          "https://quickbooks.api.intuit.com/v3/company",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "quickbooks" },
      };
    case "xero":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:xero",
        clientId,
        authorizationEndpoint:
          process.env[envKey("xero", "AUTHORIZATION_URL")]?.trim() ||
          "https://login.xero.com/identity/connect/authorize",
        tokenEndpoint:
          process.env[envKey("xero", "TOKEN_URL")]?.trim() ||
          "https://identity.xero.com/connect/token",
        callbackId: "xero",
        callbackUrl: readEnvCallbackUrl(
          "xero",
          "https://stella.sh/oauth/xero/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("xero", XERO_SCOPES),
        resourceUrl:
          process.env[envKey("xero", "RESOURCE_URL")]?.trim() ||
          "https://api.xero.com/api.xro/2.0",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "xero" },
      };
    case "zendesk": {
      const subdomain = process.env[envKey("zendesk", "SUBDOMAIN")]
        ?.trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\.zendesk\.com\/?$/u, "");
      const origin = subdomain ? `https://${subdomain}.zendesk.com` : null;
      const authorizationEndpoint =
        process.env[envKey("zendesk", "AUTHORIZATION_URL")]?.trim() ||
        (origin ? `${origin}/oauth/authorizations/new` : undefined);
      const tokenEndpoint =
        process.env[envKey("zendesk", "TOKEN_URL")]?.trim() ||
        (origin ? `${origin}/oauth/tokens` : undefined);
      const resourceUrl =
        process.env[envKey("zendesk", "RESOURCE_URL")]?.trim() ||
        (origin ? `${origin}/api/v2` : undefined);
      if (!authorizationEndpoint || !tokenEndpoint || !resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:zendesk",
        clientId,
        authorizationEndpoint,
        tokenEndpoint,
        callbackId: "zendesk",
        callbackUrl: readEnvCallbackUrl(
          "zendesk",
          "https://stella.sh/oauth/zendesk/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("zendesk", ZENDESK_SCOPES),
        usesPkce: readEnvUsesPkce("zendesk") ?? true,
        resourceUrl,
        tokenExchange: { type: "backend", provider: "zendesk" },
      };
    }
    case "linkedin":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:linkedin",
        clientId,
        authorizationEndpoint:
          "https://www.linkedin.com/oauth/v2/authorization",
        tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
        callbackId: "linkedin",
        callbackUrl: readEnvCallbackUrl(
          "linkedin",
          "https://stella.sh/oauth/linkedin/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("linkedin", LINKEDIN_SCOPES),
        resourceUrl: "https://api.linkedin.com/v2",
        tokenExchange: { type: "backend", provider: "linkedin" },
      };
    case "shopify": {
      const shopDomain = process.env[envKey("shopify", "SHOP_DOMAIN")]
        ?.trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "");
      const origin = shopDomain
        ? `https://${shopDomain.endsWith(".myshopify.com") ? shopDomain : `${shopDomain}.myshopify.com`}`
        : null;
      const authorizationEndpoint =
        process.env[envKey("shopify", "AUTHORIZATION_URL")]?.trim() ||
        (origin ? `${origin}/admin/oauth/authorize` : undefined);
      const tokenEndpoint =
        process.env[envKey("shopify", "TOKEN_URL")]?.trim() ||
        (origin ? `${origin}/admin/oauth/access_token` : undefined);
      const resourceUrl =
        process.env[envKey("shopify", "RESOURCE_URL")]?.trim() ||
        (origin ? `${origin}/admin/api` : undefined);
      if (!authorizationEndpoint || !tokenEndpoint || !resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:shopify",
        clientId,
        authorizationEndpoint,
        tokenEndpoint,
        callbackId: "shopify",
        callbackUrl: readEnvCallbackUrl(
          "shopify",
          "https://stella.sh/oauth/shopify/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("shopify", SHOPIFY_SCOPES),
        resourceUrl,
        tokenExchange: { type: "backend", provider: "shopify" },
      };
    }
    case "square":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:square",
        clientId,
        authorizationEndpoint:
          process.env[envKey("square", "AUTHORIZATION_URL")]?.trim() ||
          "https://connect.squareup.com/oauth2/authorize",
        tokenEndpoint:
          process.env[envKey("square", "TOKEN_URL")]?.trim() ||
          "https://connect.squareup.com/oauth2/token",
        callbackId: "square",
        callbackUrl: readEnvCallbackUrl(
          "square",
          "https://stella.sh/oauth/square/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("square", SQUARE_SCOPES),
        resourceUrl:
          process.env[envKey("square", "RESOURCE_URL")]?.trim() ||
          "https://connect.squareup.com/v2",
        tokenExchange: { type: "backend", provider: "square" },
      };
    case "strava":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:strava",
        clientId,
        authorizationEndpoint: "https://www.strava.com/oauth/authorize",
        tokenEndpoint: "https://www.strava.com/oauth/token",
        callbackId: "strava",
        callbackUrl: readEnvCallbackUrl(
          "strava",
          "https://stella.sh/oauth/strava/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("strava", STRAVA_SCOPES),
        authorizationParams: mergeAuthorizationParams("strava", {
          approval_prompt: "auto",
        }),
        resourceUrl: "https://www.strava.com/api/v3",
        tokenExchange: { type: "backend", provider: "strava" },
      };
    case "survey_monkey":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:survey_monkey",
        clientId,
        authorizationEndpoint: "https://api.surveymonkey.com/oauth/authorize",
        tokenEndpoint: "https://api.surveymonkey.com/oauth/token",
        callbackId: "survey_monkey",
        callbackUrl: readEnvCallbackUrl(
          "survey_monkey",
          "https://stella.sh/oauth/survey_monkey/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("survey_monkey", SURVEY_MONKEY_SCOPES),
        resourceUrl: "https://api.surveymonkey.com/v3",
        tokenExchange: { type: "backend", provider: "survey_monkey" },
      };
    case "docusign":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:docusign",
        clientId,
        authorizationEndpoint:
          process.env[envKey("docusign", "AUTHORIZATION_URL")]?.trim() ||
          "https://account.docusign.com/oauth/auth",
        tokenEndpoint:
          process.env[envKey("docusign", "TOKEN_URL")]?.trim() ||
          "https://account.docusign.com/oauth/token",
        callbackId: "docusign",
        callbackUrl: readEnvCallbackUrl(
          "docusign",
          "https://stella.sh/oauth/docusign/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("docusign", DOCUSIGN_SCOPES),
        resourceUrl:
          process.env[envKey("docusign", "RESOURCE_URL")]?.trim() ||
          "https://www.docusign.net/restapi",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "docusign" },
      };
    case "digital_ocean":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:digital_ocean",
        clientId,
        authorizationEndpoint:
          "https://cloud.digitalocean.com/v1/oauth/authorize",
        tokenEndpoint: "https://cloud.digitalocean.com/v1/oauth/token",
        callbackId: "digital_ocean",
        callbackUrl: readEnvCallbackUrl(
          "digital_ocean",
          "https://stella.sh/oauth/digital_ocean/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("digital_ocean", DIGITAL_OCEAN_SCOPES),
        resourceUrl: "https://api.digitalocean.com/v2",
        tokenExchange: { type: "backend", provider: "digital_ocean" },
      };
    case "mural":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:mural",
        clientId,
        authorizationEndpoint:
          "https://app.mural.co/api/public/v1/authorization/oauth2/authorize",
        tokenEndpoint:
          "https://app.mural.co/api/public/v1/authorization/oauth2/token",
        callbackId: "mural",
        callbackUrl: readEnvCallbackUrl(
          "mural",
          "https://stella.sh/oauth/mural/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("mural", MURAL_SCOPES),
        usesPkce: readEnvUsesPkce("mural") ?? true,
        resourceUrl: "https://app.mural.co/api/public/v1",
        tokenExchange: { type: "backend", provider: "mural" },
      };
    case "canvas": {
      const installUrl = process.env[envKey("canvas", "INSTALL_URL")]
        ?.trim()
        .replace(/\/+$/u, "");
      const authorizationEndpoint =
        process.env[envKey("canvas", "AUTHORIZATION_URL")]?.trim() ||
        (installUrl ? `${installUrl}/login/oauth2/auth` : undefined);
      const tokenEndpoint =
        process.env[envKey("canvas", "TOKEN_URL")]?.trim() ||
        (installUrl ? `${installUrl}/login/oauth2/token` : undefined);
      const resourceUrl =
        process.env[envKey("canvas", "RESOURCE_URL")]?.trim() ||
        (installUrl ? `${installUrl}/api/v1` : undefined);
      if (!authorizationEndpoint || !tokenEndpoint || !resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:canvas",
        clientId,
        authorizationEndpoint,
        tokenEndpoint,
        callbackId: "canvas",
        callbackUrl: readEnvCallbackUrl(
          "canvas",
          "https://stella.sh/oauth/canvas/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("canvas", CANVAS_SCOPES),
        resourceUrl,
        tokenExchange: { type: "backend", provider: "canvas" },
      };
    }
    case "datadog": {
      const site = process.env[envKey("datadog", "SITE")]
        ?.trim()
        .replace(/\/+$/u, "");
      const authorizationEndpoint =
        process.env[envKey("datadog", "AUTHORIZATION_URL")]?.trim() ||
        (site ? `${site}/oauth2/v1/authorize` : undefined);
      const tokenEndpoint =
        process.env[envKey("datadog", "TOKEN_URL")]?.trim() ||
        (site
          ? `${site.replace("https://app.", "https://api.")}/oauth2/v1/token`
          : undefined);
      const resourceUrl =
        process.env[envKey("datadog", "RESOURCE_URL")]?.trim() ||
        (site ? site.replace("https://app.", "https://api.") : undefined);
      if (!authorizationEndpoint || !tokenEndpoint || !resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:datadog",
        clientId,
        authorizationEndpoint,
        tokenEndpoint,
        callbackId: "datadog",
        callbackUrl: readEnvCallbackUrl(
          "datadog",
          "https://stella.sh/oauth/datadog/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("datadog", DATADOG_SCOPES),
        usesPkce: readEnvUsesPkce("datadog") ?? true,
        resourceUrl,
        tokenExchange: { type: "backend", provider: "datadog" },
      };
    }
    case "wrike":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:wrike",
        clientId,
        authorizationEndpoint: "https://login.wrike.com/oauth2/authorize/v4",
        tokenEndpoint: "https://login.wrike.com/oauth2/token",
        callbackId: "wrike",
        callbackUrl: readEnvCallbackUrl(
          "wrike",
          "https://stella.sh/oauth/wrike/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("wrike", WRIKE_SCOPES),
        scopeSeparator: ",",
        resourceUrl:
          process.env[envKey("wrike", "RESOURCE_URL")]?.trim() ||
          "https://www.wrike.com/api/v4",
        tokenExchange: { type: "backend", provider: "wrike" },
      };
    case "intercom":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:intercom",
        clientId,
        authorizationEndpoint: "https://app.intercom.com/oauth",
        tokenEndpoint: "https://api.intercom.io/auth/eagle/token",
        callbackId: "intercom",
        callbackUrl: readEnvCallbackUrl(
          "intercom",
          "https://stella.sh/oauth/intercom/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("intercom", INTERCOM_SCOPES),
        resourceUrl: "https://api.intercom.io",
        tokenExchange: { type: "backend", provider: "intercom" },
      };
    case "klaviyo":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:klaviyo",
        clientId,
        authorizationEndpoint: "https://www.klaviyo.com/oauth/authorize",
        tokenEndpoint: "https://a.klaviyo.com/oauth/token",
        callbackId: "klaviyo",
        callbackUrl: readEnvCallbackUrl(
          "klaviyo",
          "https://stella.sh/oauth/klaviyo/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("klaviyo", KLAVIYO_SCOPES),
        usesPkce: true,
        resourceUrl: "https://a.klaviyo.com/api",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "klaviyo" },
      };
    case "brevo":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:brevo",
        clientId,
        authorizationEndpoint:
          "https://oauth.brevo.com/realms/partner/oauth/authorize",
        tokenEndpoint: "https://oauth.brevo.com/realms/partner/oauth/token",
        callbackId: "brevo",
        callbackUrl: readEnvCallbackUrl(
          "brevo",
          "https://stella.sh/oauth/brevo/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("brevo", BREVO_SCOPES),
        resourceUrl: "https://api.brevo.com/v3",
        tokenExchange: { type: "backend", provider: "brevo" },
      };
    case "ynab":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:ynab",
        clientId,
        authorizationEndpoint: "https://app.ynab.com/oauth/authorize",
        tokenEndpoint: "https://app.ynab.com/oauth/token",
        callbackId: "ynab",
        callbackUrl: readEnvCallbackUrl(
          "ynab",
          "https://stella.sh/oauth/ynab/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("ynab", YNAB_SCOPES),
        usesPkce: readEnvUsesPkce("ynab") ?? true,
        resourceUrl: "https://api.ynab.com/v1",
        tokenExchange: { type: "backend", provider: "ynab" },
      };
    case "webex":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:webex",
        clientId,
        authorizationEndpoint: "https://webexapis.com/v1/authorize",
        tokenEndpoint: "https://webexapis.com/v1/access_token",
        callbackId: "webex",
        callbackUrl: readEnvCallbackUrl(
          "webex",
          "https://stella.sh/oauth/webex/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("webex", WEBEX_SCOPES),
        resourceUrl: "https://webexapis.com/v1",
        tokenExchange: { type: "backend", provider: "webex" },
      };
    case "productboard":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:productboard",
        clientId,
        authorizationEndpoint: "https://app.productboard.com/oauth2/authorize",
        tokenEndpoint: "https://app.productboard.com/oauth2/token",
        callbackId: "productboard",
        callbackUrl: readEnvCallbackUrl(
          "productboard",
          "https://stella.sh/oauth/productboard/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("productboard", PRODUCTBOARD_SCOPES),
        resourceUrl: "https://api.productboard.com",
        tokenExchange: { type: "backend", provider: "productboard" },
      };
    case "gorgias": {
      const subdomain = process.env[envKey("gorgias", "SUBDOMAIN")]
        ?.trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\.gorgias\.com\/?$/u, "");
      const origin = subdomain ? `https://${subdomain}.gorgias.com` : null;
      const authorizationEndpoint =
        process.env[envKey("gorgias", "AUTHORIZATION_URL")]?.trim() ||
        (origin ? `${origin}/oauth/authorize` : undefined);
      const tokenEndpoint =
        process.env[envKey("gorgias", "TOKEN_URL")]?.trim() ||
        (origin ? `${origin}/oauth/token` : undefined);
      const resourceUrl =
        process.env[envKey("gorgias", "RESOURCE_URL")]?.trim() ||
        (origin ? `${origin}/api` : undefined);
      if (!authorizationEndpoint || !tokenEndpoint || !resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:gorgias",
        clientId,
        authorizationEndpoint,
        tokenEndpoint,
        callbackId: "gorgias",
        callbackUrl: readEnvCallbackUrl(
          "gorgias",
          "https://stella.sh/oauth/gorgias/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("gorgias", GORGIAS_SCOPES),
        resourceUrl,
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "gorgias" },
      };
    }
    case "canva":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:canva",
        clientId,
        authorizationEndpoint: "https://www.canva.com/api/oauth/authorize",
        tokenEndpoint: "https://api.canva.com/rest/v1/oauth/token",
        callbackId: "canva",
        callbackUrl: readEnvCallbackUrl(
          "canva",
          "https://stella.sh/oauth/canva/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("canva", CANVA_SCOPES),
        usesPkce: true,
        resourceUrl: "https://api.canva.com/rest/v1",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "canva" },
      };
    case "bamboohr": {
      const companyDomain = process.env[envKey("bamboohr", "COMPANY_DOMAIN")]
        ?.trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\.bamboohr\.com\/?$/u, "");
      const origin = companyDomain
        ? `https://${companyDomain}.bamboohr.com`
        : null;
      const authorizationEndpoint =
        process.env[envKey("bamboohr", "AUTHORIZATION_URL")]?.trim() ||
        (origin ? `${origin}/authorize.php` : undefined);
      const tokenEndpoint =
        process.env[envKey("bamboohr", "TOKEN_URL")]?.trim() ||
        (origin ? `${origin}/token.php?request=token` : undefined);
      const resourceUrl =
        process.env[envKey("bamboohr", "RESOURCE_URL")]?.trim() ||
        (origin ? `${origin}/api/v1` : undefined);
      if (!authorizationEndpoint || !tokenEndpoint || !resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:bamboohr",
        clientId,
        authorizationEndpoint,
        tokenEndpoint,
        callbackId: "bamboohr",
        callbackUrl: readEnvCallbackUrl(
          "bamboohr",
          "https://stella.sh/oauth/bamboohr/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("bamboohr", BAMBOOHR_SCOPES),
        scopeSeparator: "+",
        authorizationParams: mergeAuthorizationParams("bamboohr", {
          request: "authorize",
        }),
        resourceUrl,
        tokenExchange: { type: "backend", provider: "bamboohr" },
      };
    }
    case "twitter":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:twitter",
        clientId,
        authorizationEndpoint: "https://x.com/i/oauth2/authorize",
        tokenEndpoint: "https://api.x.com/2/oauth2/token",
        callbackId: "twitter",
        callbackUrl: readEnvCallbackUrl(
          "twitter",
          "https://stella.sh/oauth/twitter/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("twitter", X_SCOPES),
        usesPkce: true,
        resourceUrl: "https://api.x.com/2",
      };
    case "tiktok":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:tiktok",
        clientId,
        authorizationEndpoint: "https://www.tiktok.com/v2/auth/authorize/",
        tokenEndpoint: "https://open.tiktokapis.com/v2/oauth/token/",
        callbackId: "tiktok",
        callbackUrl: readEnvCallbackUrl(
          "tiktok",
          "https://stella.sh/oauth/tiktok/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("tiktok", TIKTOK_SCOPES),
        usesPkce: true,
        authorizationClientIdParam: "client_key",
        resourceUrl: "https://open.tiktokapis.com/v2",
        tokenExchange: { type: "backend", provider: "tiktok" },
      };
    case "dropbox_sign":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:dropbox_sign",
        clientId,
        authorizationEndpoint: "https://app.hellosign.com/oauth/authorize",
        tokenEndpoint: "https://app.hellosign.com/oauth/token",
        callbackId: "dropbox_sign",
        callbackUrl: readEnvCallbackUrl(
          "dropbox_sign",
          "https://stella.sh/oauth/dropbox_sign/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("dropbox_sign", DROPBOX_SIGN_SCOPES),
        resourceUrl: "https://api.hellosign.com/v3",
        tokenExchange: { type: "backend", provider: "dropbox_sign" },
      };
    case "storyblok":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:storyblok",
        clientId,
        authorizationEndpoint:
          process.env[envKey("storyblok", "AUTHORIZATION_URL")]?.trim() ||
          "https://app.storyblok.com/oauth/authorize",
        tokenEndpoint:
          process.env[envKey("storyblok", "TOKEN_URL")]?.trim() ||
          "https://app.storyblok.com/oauth/token",
        callbackId: "storyblok",
        callbackUrl: readEnvCallbackUrl(
          "storyblok",
          "https://stella.sh/oauth/storyblok/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("storyblok", STORYBLOK_SCOPES),
        usesPkce: true,
        resourceUrl:
          process.env[envKey("storyblok", "RESOURCE_URL")]?.trim() ||
          "https://mapi.storyblok.com/v1",
        tokenExchange: { type: "backend", provider: "storyblok" },
      };
    case "shippo":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:shippo",
        clientId,
        authorizationEndpoint: "https://goshippo.com/oauth/authorize",
        tokenEndpoint: "https://goshippo.com/oauth/access_token",
        callbackId: "shippo",
        callbackUrl: readEnvCallbackUrl(
          "shippo",
          "https://stella.sh/oauth/shippo/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("shippo", SHIPPO_SCOPES),
        resourceUrl: "https://api.goshippo.com",
        tokenExchange: { type: "backend", provider: "shippo" },
      };
    case "boldsign":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:boldsign",
        clientId,
        authorizationEndpoint: "https://account.boldsign.com/connect/authorize",
        tokenEndpoint: "https://account.boldsign.com/connect/token",
        callbackId: "boldsign",
        callbackUrl: readEnvCallbackUrl(
          "boldsign",
          "https://stella.sh/oauth/boldsign/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("boldsign", BOLDSIGN_SCOPES),
        usesPkce: true,
        resourceUrl:
          process.env[envKey("boldsign", "RESOURCE_URL")]?.trim() ||
          "https://api.boldsign.com/v1",
        tokenExchange: { type: "backend", provider: "boldsign" },
      };
    case "follow_up_boss":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:follow_up_boss",
        clientId,
        authorizationEndpoint: "https://app.followupboss.com/oauth/authorize",
        tokenEndpoint: "https://app.followupboss.com/oauth/token",
        callbackId: "follow_up_boss",
        callbackUrl: readEnvCallbackUrl(
          "follow_up_boss",
          "https://stella.sh/oauth/follow_up_boss/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("follow_up_boss", FOLLOW_UP_BOSS_SCOPES),
        authorizationParams: mergeAuthorizationParams("follow_up_boss", {
          response_type: "auth_code",
          prompt: "login",
        }),
        resourceUrl: "https://api.followupboss.com/v1",
        tokenAuth: "basic",
        tokenExchange: { type: "backend", provider: "follow_up_boss" },
      };
    case "moneybird":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:moneybird",
        clientId,
        authorizationEndpoint: "https://moneybird.com/oauth/authorize",
        tokenEndpoint: "https://moneybird.com/oauth/token",
        callbackId: "moneybird",
        callbackUrl: readEnvCallbackUrl(
          "moneybird",
          "https://stella.sh/oauth/moneybird/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("moneybird", MONEYBIRD_SCOPES),
        resourceUrl: "https://moneybird.com/api/v2",
        tokenExchange: { type: "backend", provider: "moneybird" },
      };
    case "workable":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:workable",
        clientId,
        authorizationEndpoint: "https://www.workable.com/oauth/authorize",
        tokenEndpoint: "https://www.workable.com/oauth/token",
        callbackId: "workable",
        callbackUrl: readEnvCallbackUrl(
          "workable",
          "https://stella.sh/oauth/workable/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("workable", WORKABLE_SCOPES),
        scopeSeparator: "+",
        authorizationParams: mergeAuthorizationParams("workable", {
          resource: "user",
        }),
        resourceUrl: "https://www.workable.com/spi/v3",
        tokenExchange: { type: "backend", provider: "workable" },
      };
    case "basecamp":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:basecamp",
        clientId,
        authorizationEndpoint:
          "https://launchpad.37signals.com/authorization/new",
        tokenEndpoint: "https://launchpad.37signals.com/authorization/token",
        callbackId: "basecamp",
        callbackUrl: readEnvCallbackUrl(
          "basecamp",
          "https://stella.sh/oauth/basecamp/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("basecamp", BASECAMP_SCOPES),
        resourceUrl: "https://launchpad.37signals.com",
        tokenExchange: { type: "backend", provider: "basecamp" },
      };
    case "beeminder":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:beeminder",
        clientId,
        authorizationEndpoint: "https://www.beeminder.com/apps/authorize",
        responseType: "token",
        callbackId: "beeminder",
        callbackUrl: readEnvCallbackUrl(
          "beeminder",
          "https://stella.sh/oauth/beeminder/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("beeminder", BEEMINDER_SCOPES),
        resourceUrl: "https://www.beeminder.com/api/v1",
      };
    case "fly":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:fly",
        clientId,
        authorizationEndpoint: "https://api.fly.io/oauth/authorize",
        tokenEndpoint: "https://api.fly.io/oauth/token",
        callbackId: "fly",
        callbackUrl: readEnvCallbackUrl(
          "fly",
          "https://stella.sh/oauth/fly/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("fly", FLY_SCOPES),
        resourceUrl: "https://api.fly.io",
        tokenExchange: { type: "backend", provider: "fly" },
      };
    case "fathom":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:fathom",
        clientId,
        authorizationEndpoint:
          "https://fathom.video/external/v1/oauth2/authorize",
        tokenEndpoint: "https://fathom.video/external/v1/oauth2/token",
        callbackId: "fathom",
        callbackUrl: readEnvCallbackUrl(
          "fathom",
          "https://stella.sh/oauth/fathom/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("fathom", FATHOM_SCOPES),
        resourceUrl: "https://api.fathom.ai/external/v1",
        tokenExchange: { type: "backend", provider: "fathom" },
      };
    case "hugging_face":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:hugging_face",
        clientId,
        authorizationEndpoint: "https://huggingface.co/oauth/authorize",
        tokenEndpoint: "https://huggingface.co/oauth/token",
        callbackId: "hugging_face",
        callbackUrl: readEnvCallbackUrl(
          "hugging_face",
          "https://stella.sh/oauth/hugging_face/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("hugging_face", HUGGING_FACE_SCOPES),
        usesPkce: true,
        resourceUrl: "https://huggingface.co/api",
      };
    case "whop":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:whop",
        clientId,
        authorizationEndpoint: "https://api.whop.com/oauth/authorize",
        tokenEndpoint: "https://api.whop.com/oauth/token",
        callbackId: "whop",
        callbackUrl: readEnvCallbackUrl(
          "whop",
          "https://stella.sh/oauth/whop/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("whop", WHOP_SCOPES),
        usesPkce: true,
        resourceUrl: "https://api.whop.com/api/v5",
        tokenExchange: { type: "backend", provider: "whop" },
      };
    case "xata":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:xata",
        clientId,
        authorizationEndpoint:
          "https://app.xata.io/integrations/oauth/authorize",
        tokenEndpoint: "https://app.xata.io/api/integrations/oauth/token",
        callbackId: "xata",
        callbackUrl: readEnvCallbackUrl(
          "xata",
          "https://stella.sh/oauth/xata/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("xata", XATA_SCOPES),
        usesPkce: false,
        resourceUrl: "https://api.xata.tech",
        tokenExchange: { type: "backend", provider: "xata" },
      };
    case "pagerduty":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:pagerduty",
        clientId,
        authorizationEndpoint: "https://identity.pagerduty.com/oauth/authorize",
        tokenEndpoint: "https://identity.pagerduty.com/oauth/token",
        callbackId: "pagerduty",
        callbackUrl: readEnvCallbackUrl(
          "pagerduty",
          "https://stella.sh/oauth/pagerduty/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("pagerduty", PAGERDUTY_SCOPES),
        usesPkce: true,
        resourceUrl: "https://api.pagerduty.com",
        tokenExchange: { type: "backend", provider: "pagerduty" },
      };
    case "contentful":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:contentful",
        clientId,
        authorizationEndpoint: "https://be.contentful.com/oauth/authorize",
        tokenEndpoint: "https://be.contentful.com/oauth/token",
        callbackId: "contentful",
        callbackUrl: readEnvCallbackUrl(
          "contentful",
          "https://stella.sh/oauth/contentful/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("contentful", CONTENTFUL_SCOPES),
        resourceUrl: "https://api.contentful.com",
        tokenExchange: { type: "backend", provider: "contentful" },
      };
    case "databricks": {
      const workspaceUrl = process.env[envKey("databricks", "WORKSPACE_URL")]
        ?.trim()
        .replace(/\/+$/u, "");
      if (!workspaceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:databricks",
        clientId,
        authorizationEndpoint:
          process.env[envKey("databricks", "AUTHORIZATION_URL")]?.trim() ||
          `${workspaceUrl}/oidc/v1/authorize`,
        tokenEndpoint:
          process.env[envKey("databricks", "TOKEN_URL")]?.trim() ||
          `${workspaceUrl}/oidc/v1/token`,
        callbackId: "databricks",
        callbackUrl: readEnvCallbackUrl("databricks", DEFAULT_CALLBACK_URL),
        scopes: readEnvScopesOrDefault("databricks", DATABRICKS_SCOPES),
        usesPkce: true,
        resourceUrl:
          process.env[envKey("databricks", "RESOURCE_URL")]?.trim() ||
          `${workspaceUrl}/api/2.0`,
      };
    }
    case "egnyte": {
      const domain = process.env[envKey("egnyte", "DOMAIN")]
        ?.trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\/+$/u, "");
      if (!domain) return null;
      const origin = `https://${domain}`;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:egnyte",
        clientId,
        authorizationEndpoint:
          process.env[envKey("egnyte", "AUTHORIZATION_URL")]?.trim() ||
          `${origin}/puboauth/token`,
        tokenEndpoint:
          process.env[envKey("egnyte", "TOKEN_URL")]?.trim() ||
          `${origin}/puboauth/token`,
        callbackId: "egnyte",
        callbackUrl: readEnvCallbackUrl(
          "egnyte",
          "https://stella.sh/oauth/egnyte/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("egnyte", EGNYTE_SCOPES),
        resourceUrl:
          process.env[envKey("egnyte", "RESOURCE_URL")]?.trim() ||
          `${origin}/pubapi/v1`,
        tokenExchange: { type: "backend", provider: "egnyte" },
      };
    }
    case "apaleo":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:apaleo",
        clientId,
        authorizationEndpoint: "https://identity.apaleo.com/connect/authorize",
        tokenEndpoint: "https://identity.apaleo.com/connect/token",
        callbackId: "apaleo",
        callbackUrl: readEnvCallbackUrl(
          "apaleo",
          "https://stella.sh/oauth/apaleo/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("apaleo", APALEO_SCOPES),
        resourceUrl: "https://api.apaleo.com",
        tokenExchange: { type: "backend", provider: "apaleo" },
      };
    case "dialpad":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:dialpad",
        clientId,
        authorizationEndpoint:
          process.env[envKey("dialpad", "AUTHORIZATION_URL")]?.trim() ||
          "https://dialpad.com/oauth2/authorize",
        tokenEndpoint:
          process.env[envKey("dialpad", "TOKEN_URL")]?.trim() ||
          "https://dialpad.com/oauth2/token",
        callbackId: "dialpad",
        callbackUrl: readEnvCallbackUrl(
          "dialpad",
          "https://stella.sh/oauth/dialpad/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("dialpad", DIALPAD_SCOPES),
        usesPkce: true,
        resourceUrl: "https://dialpad.com/api/v2",
        tokenExchange: { type: "backend", provider: "dialpad" },
      };
    case "servicem8":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:servicem8",
        clientId,
        authorizationEndpoint: "https://go.servicem8.com/oauth/authorize",
        tokenEndpoint: "https://go.servicem8.com/oauth/access_token",
        callbackId: "servicem8",
        callbackUrl: readEnvCallbackUrl(
          "servicem8",
          "https://stella.sh/oauth/servicem8/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("servicem8", SERVICEM8_SCOPES),
        resourceUrl: "https://api.servicem8.com/api_1.0",
        tokenExchange: { type: "backend", provider: "servicem8" },
      };
    case "timely":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:timely",
        clientId,
        authorizationEndpoint: "https://api.timelyapp.com/1.1/oauth/authorize",
        tokenEndpoint: "https://api.timelyapp.com/1.1/oauth/token",
        callbackId: "timely",
        callbackUrl: readEnvCallbackUrl(
          "timely",
          "https://stella.sh/oauth/timely/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("timely", TIMELY_SCOPES),
        resourceUrl: "https://api.timelyapp.com/1.1",
        tokenExchange: { type: "backend", provider: "timely" },
      };
    case "kommo": {
      const domain = (
        process.env[envKey("kommo", "SUBDOMAIN")] ??
        process.env[envKey("kommo", "DOMAIN")] ??
        ""
      )
        .trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "")
        .replace(/\.kommo\.com$/u, "");
      if (!domain) return null;
      const accountOrigin = `https://${domain}.kommo.com`;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:kommo",
        clientId,
        authorizationEndpoint:
          process.env[envKey("kommo", "AUTHORIZATION_URL")]?.trim() ||
          "https://www.kommo.com/oauth",
        tokenEndpoint:
          process.env[envKey("kommo", "TOKEN_URL")]?.trim() ||
          `${accountOrigin}/oauth2/access_token`,
        callbackId: "kommo",
        callbackUrl: readEnvCallbackUrl(
          "kommo",
          "https://stella.sh/oauth/kommo/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("kommo", KOMMO_SCOPES),
        resourceUrl:
          process.env[envKey("kommo", "RESOURCE_URL")]?.trim() ||
          `${accountOrigin}/api/v4`,
        tokenExchange: { type: "backend", provider: "kommo" },
      };
    }
    case "gong":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:gong",
        clientId,
        authorizationEndpoint: "https://app.gong.io/oauth2/authorize",
        tokenEndpoint: "https://app.gong.io/oauth2/generate-customer-token",
        callbackId: "gong",
        callbackUrl: readEnvCallbackUrl(
          "gong",
          "https://stella.sh/oauth/gong/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("gong", GONG_SCOPES),
        tokenAuth: "basic",
        resourceUrl: "https://api.gong.io",
        tokenExchange: { type: "backend", provider: "gong" },
      };
    case "snowflake": {
      const accountUrl = (
        process.env[envKey("snowflake", "ACCOUNT_URL")] ??
        process.env[envKey("snowflake", "HOST")] ??
        process.env[envKey("snowflake", "RESOURCE_URL")] ??
        ""
      )
        .trim()
        .replace(/\/+$/u, "");
      if (!accountUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:snowflake",
        clientId,
        authorizationEndpoint:
          process.env[envKey("snowflake", "AUTHORIZATION_URL")]?.trim() ||
          `${accountUrl}/oauth/authorize`,
        tokenEndpoint:
          process.env[envKey("snowflake", "TOKEN_URL")]?.trim() ||
          `${accountUrl}/oauth/token-request`,
        callbackId: "snowflake",
        callbackUrl: readEnvCallbackUrl(
          "snowflake",
          "https://stella.sh/oauth/snowflake/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("snowflake", SNOWFLAKE_SCOPES),
        usesPkce: true,
        tokenAuth: "basic",
        resourceUrl: accountUrl,
        tokenExchange: { type: "backend", provider: "snowflake" },
      };
    }
    case "netsuite": {
      const rawAccount = (
        process.env[envKey("netsuite", "ACCOUNT_DOMAIN")] ??
        process.env[envKey("netsuite", "ACCOUNT_ID")] ??
        ""
      ).trim();
      if (!rawAccount) return null;
      const host = rawAccount
        .replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "")
        .toLowerCase();
      const accountId = host
        .replace(/\.app\.netsuite\.com$/u, "")
        .replace(/\.suitetalk\.api\.netsuite\.com$/u, "")
        .replace(/_/gu, "-");
      const appOrigin = host.endsWith(".app.netsuite.com")
        ? `https://${host}`
        : `https://${accountId}.app.netsuite.com`;
      const suiteTalkOrigin = host.endsWith(".suitetalk.api.netsuite.com")
        ? `https://${host}`
        : `https://${accountId}.suitetalk.api.netsuite.com`;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:netsuite",
        clientId,
        authorizationEndpoint:
          process.env[envKey("netsuite", "AUTHORIZATION_URL")]?.trim() ||
          `${appOrigin}/app/login/oauth2/authorize.nl`,
        tokenEndpoint:
          process.env[envKey("netsuite", "TOKEN_URL")]?.trim() ||
          `${suiteTalkOrigin}/services/rest/auth/oauth2/v1/token`,
        callbackId: "netsuite",
        callbackUrl: readEnvCallbackUrl(
          "netsuite",
          "https://stella.sh/oauth/netsuite/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("netsuite", NETSUITE_SCOPES),
        tokenAuth: "basic",
        resourceUrl:
          process.env[envKey("netsuite", "RESOURCE_URL")]?.trim() ||
          `${suiteTalkOrigin}/services/rest`,
        tokenExchange: { type: "backend", provider: "netsuite" },
      };
    }
    case "coupa": {
      const domain = (
        process.env[envKey("coupa", "DOMAIN")] ??
        process.env[envKey("coupa", "HOST")] ??
        ""
      )
        .trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "");
      if (!domain) return null;
      const origin = `https://${domain}`;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:coupa",
        clientId,
        authorizationEndpoint:
          process.env[envKey("coupa", "AUTHORIZATION_URL")]?.trim() ||
          `${origin}/oauth2/authorize`,
        tokenEndpoint:
          process.env[envKey("coupa", "TOKEN_URL")]?.trim() ||
          `${origin}/oauth2/token`,
        callbackId: "coupa",
        callbackUrl: readEnvCallbackUrl(
          "coupa",
          "https://stella.sh/oauth/coupa/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("coupa", COUPA_SCOPES),
        resourceUrl:
          process.env[envKey("coupa", "RESOURCE_URL")]?.trim() || origin,
        tokenExchange: { type: "backend", provider: "coupa" },
      };
    }
    case "d2lbrightspace": {
      const resourceUrl = (
        process.env[envKey("d2lbrightspace", "RESOURCE_URL")] ??
        process.env[envKey("d2lbrightspace", "HOST")] ??
        ""
      )
        .trim()
        .replace(/\/+$/u, "");
      if (!resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:d2lbrightspace",
        clientId,
        authorizationEndpoint: "https://auth.brightspace.com/oauth2/auth",
        tokenEndpoint: "https://auth.brightspace.com/core/connect/token",
        callbackId: "d2lbrightspace",
        callbackUrl: readEnvCallbackUrl(
          "d2lbrightspace",
          "https://stella.sh/oauth/d2lbrightspace/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault(
          "d2lbrightspace",
          D2L_BRIGHTSPACE_SCOPES,
        ),
        resourceUrl,
        tokenExchange: { type: "backend", provider: "d2lbrightspace" },
      };
    }
    case "blackboard": {
      const instanceUrl = (
        process.env[envKey("blackboard", "INSTANCE_URL")] ??
        process.env[envKey("blackboard", "HOST")] ??
        ""
      )
        .trim()
        .replace(/\/+$/u, "");
      if (!instanceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:blackboard",
        clientId,
        authorizationEndpoint:
          process.env[envKey("blackboard", "AUTHORIZATION_URL")]?.trim() ||
          `${instanceUrl}/learn/api/public/v1/oauth2/authorizationcode`,
        tokenEndpoint:
          process.env[envKey("blackboard", "TOKEN_URL")]?.trim() ||
          `${instanceUrl}/learn/api/public/v1/oauth2/token`,
        callbackId: "blackboard",
        callbackUrl: readEnvCallbackUrl(
          "blackboard",
          "https://stella.sh/oauth/blackboard/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("blackboard", BLACKBOARD_SCOPES),
        usesPkce: true,
        authorizationRedirectParam: "redirect_url",
        tokenRedirectParam: "redirect_url",
        tokenAuth: "basic",
        resourceUrl: `${instanceUrl}/learn/api/public/v1`,
        tokenExchange: { type: "backend", provider: "blackboard" },
      };
    }
    case "dub":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:dub",
        clientId,
        authorizationEndpoint: "https://app.dub.co/oauth/authorize",
        tokenEndpoint: "https://api.dub.co/oauth/token",
        callbackId: "dub",
        callbackUrl: readEnvCallbackUrl(
          "dub",
          "https://stella.sh/oauth/dub/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("dub", DUB_SCOPES),
        usesPkce: true,
        resourceUrl: "https://api.dub.co",
        tokenExchange: { type: "backend", provider: "dub" },
      };
    case "blackbaud":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:blackbaud",
        clientId,
        authorizationEndpoint:
          process.env[envKey("blackbaud", "AUTHORIZATION_URL")]?.trim() ||
          "https://oauth2.sky.blackbaud.com/authorization",
        tokenEndpoint:
          process.env[envKey("blackbaud", "TOKEN_URL")]?.trim() ||
          "https://oauth2.sky.blackbaud.com/token",
        callbackId: "blackbaud",
        callbackUrl: readEnvCallbackUrl(
          "blackbaud",
          "https://stella.sh/oauth/blackbaud/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("blackbaud", BLACKBAUD_SCOPES),
        resourceUrl: "https://api.sky.blackbaud.com",
        tokenExchange: { type: "backend", provider: "blackbaud" },
      };
    case "exist":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:exist",
        clientId,
        authorizationEndpoint: "https://exist.io/oauth2/authorize",
        tokenEndpoint: "https://exist.io/oauth2/access_token",
        callbackId: "exist",
        callbackUrl: readEnvCallbackUrl(
          "exist",
          "https://stella.sh/oauth/exist/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("exist", EXIST_SCOPES),
        resourceUrl: "https://exist.io/api/2",
        tokenExchange: { type: "backend", provider: "exist" },
      };
    case "omnisend":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:omnisend",
        clientId,
        authorizationEndpoint:
          process.env[envKey("omnisend", "AUTHORIZATION_URL")]?.trim() ||
          "https://app.omnisend.com/oauth2/authorize",
        tokenEndpoint:
          process.env[envKey("omnisend", "TOKEN_URL")]?.trim() ||
          "https://app.omnisend.com/oauth2/token",
        callbackId: "omnisend",
        callbackUrl: readEnvCallbackUrl(
          "omnisend",
          "https://stella.sh/oauth/omnisend/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("omnisend", OMNISEND_SCOPES),
        resourceUrl: "https://api.omnisend.com",
        tokenExchange: { type: "backend", provider: "omnisend" },
      };
    case "ramp":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:ramp",
        clientId,
        authorizationEndpoint:
          process.env[envKey("ramp", "AUTHORIZATION_URL")]?.trim() ||
          "https://app.ramp.com/v1/authorize",
        tokenEndpoint:
          process.env[envKey("ramp", "TOKEN_URL")]?.trim() ||
          "https://api.ramp.com/developer/v1/token",
        callbackId: "ramp",
        callbackUrl: readEnvCallbackUrl(
          "ramp",
          "https://stella.sh/oauth/ramp/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("ramp", RAMP_SCOPES),
        tokenAuth: "basic",
        resourceUrl: "https://api.ramp.com/developer/v1",
        tokenExchange: { type: "backend", provider: "ramp" },
      };
    case "brex":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:brex",
        clientId,
        authorizationEndpoint:
          process.env[envKey("brex", "AUTHORIZATION_URL")]?.trim() ||
          "https://accounts-api.brex.com/oauth2/default/v1/authorize",
        tokenEndpoint:
          process.env[envKey("brex", "TOKEN_URL")]?.trim() ||
          "https://accounts-api.brex.com/oauth2/default/v1/token",
        callbackId: "brex",
        callbackUrl: readEnvCallbackUrl(
          "brex",
          "https://stella.sh/oauth/brex/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("brex", BREX_SCOPES),
        tokenAuth: "basic",
        resourceUrl: "https://platform.brexapis.com",
        tokenExchange: { type: "backend", provider: "brex" },
      };
    case "workday": {
      const host = (
        process.env[envKey("workday", "HOST")] ??
        process.env[envKey("workday", "RESOURCE_URL")] ??
        ""
      )
        .trim()
        .replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "");
      const tenant = process.env[envKey("workday", "TENANT")]?.trim();
      if (!host || !tenant) return null;
      const origin = `https://${host}`;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:workday",
        clientId,
        authorizationEndpoint:
          process.env[envKey("workday", "AUTHORIZATION_URL")]?.trim() ||
          `${origin}/ccx/oauth2/${tenant}/authorize`,
        tokenEndpoint:
          process.env[envKey("workday", "TOKEN_URL")]?.trim() ||
          `${origin}/ccx/oauth2/${tenant}/token`,
        callbackId: "workday",
        callbackUrl: readEnvCallbackUrl(
          "workday",
          "https://stella.sh/oauth/workday/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("workday", WORKDAY_SCOPES),
        tokenAuth: "basic",
        resourceUrl:
          process.env[envKey("workday", "RESOURCE_URL")]?.trim() ||
          `${origin}/ccx/api`,
        tokenExchange: { type: "backend", provider: "workday" },
      };
    }
    case "yandex":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:yandex",
        clientId,
        authorizationEndpoint:
          process.env[envKey("yandex", "AUTHORIZATION_URL")]?.trim() ||
          "https://oauth.yandex.com/authorize",
        tokenEndpoint:
          process.env[envKey("yandex", "TOKEN_URL")]?.trim() ||
          "https://oauth.yandex.com/token",
        callbackId: "yandex",
        callbackUrl: readEnvCallbackUrl(
          "yandex",
          "https://stella.sh/oauth/yandex/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("yandex", YANDEX_SCOPES),
        apiAuthScheme: "oauth",
        resourceUrl:
          process.env[envKey("yandex", "RESOURCE_URL")]?.trim() ||
          "https://cloud-api.yandex.net/v1",
        tokenExchange: { type: "backend", provider: "yandex" },
      };
    case "dynamics365": {
      const resourceUrl = (
        process.env[envKey("dynamics365", "RESOURCE_URL")] ??
        process.env[envKey("dynamics365", "ORG_URL")] ??
        ""
      )
        .trim()
        .replace(/\/+$/u, "");
      if (!resourceUrl) return null;
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:dynamics365",
        clientId,
        authorizationEndpoint:
          process.env[envKey("dynamics365", "AUTHORIZATION_URL")]?.trim() ||
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenEndpoint:
          process.env[envKey("dynamics365", "TOKEN_URL")]?.trim() ||
          "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        callbackId: "dynamics365",
        callbackUrl: readEnvCallbackUrl(
          "dynamics365",
          "https://stella.sh/oauth/dynamics365/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("dynamics365", [
          ...DYNAMICS365_SCOPES,
          `${resourceUrl}/user_impersonation`,
        ]),
        resourceUrl,
        tokenExchange: { type: "backend", provider: "dynamics365" },
      };
    }
    case "kit":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:kit",
        clientId,
        authorizationEndpoint:
          process.env[envKey("kit", "AUTHORIZATION_URL")]?.trim() ||
          "https://api.kit.com/v4/oauth/authorize",
        tokenEndpoint:
          process.env[envKey("kit", "TOKEN_URL")]?.trim() ||
          "https://api.kit.com/v4/oauth/token",
        callbackId: "kit",
        callbackUrl: readEnvCallbackUrl(
          "kit",
          "https://stella.sh/oauth/kit/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("kit", KIT_SCOPES),
        usesPkce: readEnvUsesPkce("kit") ?? true,
        resourceUrl: "https://api.kit.com/v4",
        tokenExchange: { type: "backend", provider: "kit" },
      };
    case "lever":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:lever",
        clientId,
        authorizationEndpoint:
          process.env[envKey("lever", "AUTHORIZATION_URL")]?.trim() ||
          "https://auth.lever.co/authorize",
        tokenEndpoint:
          process.env[envKey("lever", "TOKEN_URL")]?.trim() ||
          "https://auth.lever.co/oauth/token",
        callbackId: "lever",
        callbackUrl: readEnvCallbackUrl(
          "lever",
          "https://stella.sh/oauth/lever/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("lever", LEVER_SCOPES),
        authorizationParams: mergeAuthorizationParams("lever", {
          audience: "https://api.lever.co/v1/",
        }),
        resourceUrl: "https://api.lever.co/v1",
        tokenExchange: { type: "backend", provider: "lever" },
      };
    case "linkhut":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:linkhut",
        clientId,
        authorizationEndpoint:
          process.env[envKey("linkhut", "AUTHORIZATION_URL")]?.trim() ||
          "https://ln.ht/_/oauth/authorize",
        tokenEndpoint:
          process.env[envKey("linkhut", "TOKEN_URL")]?.trim() ||
          "https://api.ln.ht/v1/oauth/token",
        callbackId: "linkhut",
        callbackUrl: readEnvCallbackUrl(
          "linkhut",
          "https://stella.sh/oauth/linkhut/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("linkhut", LINKHUT_SCOPES),
        resourceUrl: "https://api.ln.ht/v1",
        tokenExchange: { type: "backend", provider: "linkhut" },
      };
    case "prisma":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:prisma",
        clientId,
        authorizationEndpoint:
          process.env[envKey("prisma", "AUTHORIZATION_URL")]?.trim() ||
          "https://auth.prisma.io/authorize",
        tokenEndpoint:
          process.env[envKey("prisma", "TOKEN_URL")]?.trim() ||
          "https://auth.prisma.io/token",
        callbackId: "prisma",
        callbackUrl: readEnvCallbackUrl(
          "prisma",
          "https://stella.sh/oauth/prisma/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("prisma", PRISMA_SCOPES),
        usesPkce: readEnvUsesPkce("prisma") ?? true,
        resourceUrl: "https://api.prisma.io/v1",
        tokenExchange: { type: "backend", provider: "prisma" },
      };
    case "toneden":
      return {
        flow: "authorization_code",
        tokenKey: "native-oauth:toneden",
        clientId,
        authorizationEndpoint:
          process.env[envKey("toneden", "AUTHORIZATION_URL")]?.trim() ||
          "https://www.toneden.io/auth/oauth2/authorize",
        tokenEndpoint:
          process.env[envKey("toneden", "TOKEN_URL")]?.trim() ||
          "https://www.toneden.io/auth/oauth2/token",
        callbackId: "toneden",
        callbackUrl: readEnvCallbackUrl(
          "toneden",
          "https://stella.sh/oauth/toneden/callback",
        ),
        callbackMode: "external",
        scopes: readEnvScopesOrDefault("toneden", TONEDEN_SCOPES),
        resourceUrl: "https://www.toneden.io/api/v1",
        tokenExchange: { type: "backend", provider: "toneden" },
      };
    default:
      return null;
  }
};

const BUILTIN_NATIVE_OAUTH: Record<string, NativeOAuthProviderConfig> = {
  github: {
    flow: "device",
    tokenKey: "native-oauth:github",
    clientId: "Ov23liHtoBx5A9dr9ZVE",
    deviceAuthorizationEndpoint: "https://github.com/login/device/code",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    verificationUri: "https://github.com/login/device",
    scopes: ["repo", "read:user", "user:email"],
    resourceUrl: "https://api.github.com",
  },
  linear: {
    flow: "authorization_code",
    tokenKey: "native-oauth:linear",
    clientId: "d9b8130b53008f5c39c8040b1c847400",
    authorizationEndpoint: "https://linear.app/oauth/authorize",
    tokenEndpoint: "https://api.linear.app/oauth/token",
    callbackId: "linear",
    callbackUrl: "http://127.0.0.1:48743/callback",
    scopes: ["read", "write"],
    scopeSeparator: ",",
    resourceUrl: "https://api.linear.app",
  },
  youtube: {
    flow: "authorization_code",
    tokenKey: "native-oauth:youtube",
    clientId:
      process.env.WORKSPACE_CLIENT_ID ??
      "398468929332-q768etk5go3lbjbdh9nth3d505pc7aqk.apps.googleusercontent.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    callbackId: "youtube",
    callbackUrl: "http://127.0.0.1:48743/callback",
    scopes: [
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtubepartner",
    ],
    authorizationParams: {
      access_type: "offline",
      prompt: "consent",
    },
    resourceUrl: "https://www.googleapis.com/youtube/v3",
  },
  todoist: {
    flow: "authorization_code",
    tokenKey: "native-oauth:todoist",
    clientId: "df6dc28ee1c44f1d980ba3941328f48b",
    authorizationEndpoint: "https://app.todoist.com/oauth/authorize",
    tokenEndpoint: "https://api.todoist.com/oauth/access_token",
    callbackId: "todoist",
    callbackUrl: "http://127.0.0.1:48743/callback",
    scopes: ["task:add", "data:read", "data:read_write"],
    resourceUrl: "https://api.todoist.com",
    tokenExchange: { type: "backend", provider: "todoist" },
  },
  ticktick: {
    flow: "authorization_code",
    tokenKey: "native-oauth:ticktick",
    clientId: "dP7P1rhfLp8g57aCWN",
    authorizationEndpoint: "https://ticktick.com/oauth/authorize",
    tokenEndpoint: "https://ticktick.com/oauth/token",
    callbackId: "ticktick",
    callbackUrl: "http://127.0.0.1:48743/callback",
    scopes: ["tasks:read", "tasks:write"],
    resourceUrl: "https://api.ticktick.com/open/v1",
    tokenExchange: { type: "backend", provider: "ticktick" },
  },
  asana: {
    flow: "authorization_code",
    tokenKey: "native-oauth:asana",
    clientId: "1214879058461640",
    authorizationEndpoint: "https://app.asana.com/-/oauth_authorize",
    tokenEndpoint: "https://app.asana.com/-/oauth_token",
    callbackId: "asana",
    callbackUrl: "http://127.0.0.1:48743/callback",
    resourceUrl: "https://app.asana.com/api/1.0",
    tokenExchange: { type: "backend", provider: "asana" },
  },
  airtable: {
    flow: "authorization_code",
    tokenKey: "native-oauth:airtable",
    clientId: "176b8081-ada9-4740-ae2c-7c82fcb691e1",
    authorizationEndpoint: "https://airtable.com/oauth2/v1/authorize",
    tokenEndpoint: "https://airtable.com/oauth2/v1/token",
    callbackId: "airtable",
    callbackUrl: "https://stella.sh/oauth/airtable/callback",
    callbackMode: "external",
    scopes: [
      "data.recordComments:read",
      "data.recordComments:write",
      "data.records:read",
      "data.records:write",
      "schema.bases:read",
      "schema.bases:write",
      "user.email:read",
      "workspacesAndBases:read",
      "workspacesAndBases:write",
      "webhook:manage",
    ],
    resourceUrl: "https://api.airtable.com/v0",
  },
  figma: {
    flow: "authorization_code",
    tokenKey: "native-oauth:figma",
    clientId: "jAumR4HSMZeysxFniO31VU",
    authorizationEndpoint: "https://www.figma.com/oauth",
    tokenEndpoint: "https://api.figma.com/v1/oauth/token",
    callbackId: "figma",
    callbackUrl: "http://127.0.0.1:48743/callback",
    scopes: [
      "current_user:read",
      "file_comments:read",
      "file_content:read",
      "file_metadata:read",
      "projects:read",
      "webhooks:read",
    ],
    scopeSeparator: ",",
    resourceUrl: "https://api.figma.com/v1",
    tokenExchange: { type: "backend", provider: "figma" },
  },
  notion: {
    flow: "authorization_code",
    tokenKey: "native-oauth:notion",
    clientId: "364d872b-594c-81af-b558-003702a4f512",
    authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    callbackId: "notion",
    callbackUrl: "https://stella.sh/oauth/notion/callback",
    callbackMode: "external",
    resourceUrl: "https://api.notion.com/v1",
    tokenExchange: { type: "backend", provider: "notion" },
  },
  miro: {
    flow: "authorization_code",
    tokenKey: "native-oauth:miro",
    clientId: "3458764672174422737",
    authorizationEndpoint: "https://miro.com/oauth/authorize",
    tokenEndpoint: "https://api.miro.com/v1/oauth/token",
    callbackId: "miro",
    callbackUrl: "https://stella.sh/oauth/miro/callback",
    callbackMode: "external",
    scopes: ["boards:read", "boards:write", "identity:read", "team:read"],
    resourceUrl: "https://api.miro.com/v2",
    tokenExchange: { type: "backend", provider: "miro" },
  },
  wakatime: {
    flow: "authorization_code",
    tokenKey: "native-oauth:wakatime",
    clientId: "oteUsqqvx7BCmoACxvI62GLN",
    authorizationEndpoint: "https://wakatime.com/oauth/authorize",
    tokenEndpoint: "https://wakatime.com/oauth/token",
    callbackId: "wakatime",
    callbackUrl: "http://127.0.0.1:48743/callback",
    scopes: [
      "read_summaries",
      "read_stats",
      "read_goals",
      "read_private_leaderboards",
      "email",
    ],
    resourceUrl: "https://wakatime.com/api/v1",
    tokenExchange: { type: "backend", provider: "wakatime" },
  },
  pushbullet: {
    flow: "authorization_code",
    tokenKey: "native-oauth:pushbullet",
    clientId: "DwpMFWIIPvOnmdS745lNK1r1dHR6eDFx",
    authorizationEndpoint: "https://www.pushbullet.com/authorize",
    tokenEndpoint: "https://api.pushbullet.com/oauth2/token",
    callbackId: "pushbullet",
    callbackUrl: "https://stella.sh/oauth/pushbullet/callback",
    callbackMode: "external",
    scopes: ["everything"],
    usesPkce: false,
    resourceUrl: "https://api.pushbullet.com/v2",
    tokenExchange: { type: "backend", provider: "pushbullet" },
  },
  sentry: {
    flow: "authorization_code",
    tokenKey: "native-oauth:sentry",
    clientId:
      "7d8fa6bde4e3ec2f484aa055d8468cea3c89ac81b8468e3c9ddb4cf68d49c57f",
    authorizationEndpoint: "https://sentry.io/oauth/authorize/",
    tokenEndpoint: "https://sentry.io/oauth/token/",
    callbackId: "sentry",
    callbackUrl: "https://stella.sh/oauth/sentry/callback",
    callbackMode: "external",
    scopes: [
      "event:admin",
      "event:read",
      "event:write",
      "member:admin",
      "member:read",
      "member:write",
      "org:admin",
      "org:ci",
      "org:read",
      "org:write",
      "project:admin",
      "project:read",
      "project:releases",
      "project:write",
      "team:admin",
      "team:read",
      "team:write",
    ],
    resourceUrl: "https://sentry.io/api/0",
  },
  calendly: {
    flow: "authorization_code",
    tokenKey: "native-oauth:calendly",
    clientId: "Wb0XxV28fE5gniP3nG5RzWO0SL4Iu-08opE5QHjs-RA",
    authorizationEndpoint: "https://auth.calendly.com/oauth/authorize",
    tokenEndpoint: "https://auth.calendly.com/oauth/token",
    callbackId: "calendly",
    callbackUrl: "https://stella.sh/oauth/calendly/callback",
    callbackMode: "external",
    scopes: [
      "activity_log:read",
      "availability:read",
      "availability:write",
      "data_compliance:write",
      "event_types:read",
      "event_types:write",
      "groups:read",
      "locations:read",
      "organizations:read",
      "organizations:write",
      "outgoing_communications:read",
      "routing_forms:read",
      "scheduled_events:read",
      "scheduled_events:write",
      "scheduling_links:write",
      "shares:write",
      "users:read",
      "webhooks:read",
      "webhooks:write",
    ],
    resourceUrl: "https://api.calendly.com",
    tokenExchange: { type: "backend", provider: "calendly" },
  },
  cal: {
    flow: "authorization_code",
    tokenKey: "native-oauth:cal",
    clientId:
      "40e1a618b7c1edbcf5dec9cbd9e8cdbf96b26a6eb1ed4f68867cc59a851fcf64",
    authorizationEndpoint: "https://app.cal.com/auth/oauth2/authorize",
    tokenEndpoint: "https://api.cal.com/v2/auth/oauth2/token",
    callbackId: "cal",
    callbackUrl: "https://stella.sh/oauth/cal/callback",
    callbackMode: "external",
    scopes: [
      "EVENT_TYPE_READ",
      "EVENT_TYPE_WRITE",
      "BOOKING_READ",
      "BOOKING_WRITE",
      "SCHEDULE_READ",
      "SCHEDULE_WRITE",
      "APPS_READ",
      "APPS_WRITE",
      "PROFILE_READ",
      "PROFILE_WRITE",
      "WEBHOOK_READ",
      "WEBHOOK_WRITE",
      "VERIFIED_RESOURCES_READ",
      "VERIFIED_RESOURCES_WRITE",
      "CREDITS_READ",
      "CREDITS_WRITE",
    ],
    usesPkce: true,
    resourceUrl: "https://api.cal.com/v2",
  },
  capsule_crm: {
    flow: "authorization_code",
    tokenKey: "native-oauth:capsule_crm",
    clientId: "lpbhyxgpd2at",
    authorizationEndpoint: "https://api.capsulecrm.com/oauth/authorise",
    tokenEndpoint: "https://api.capsulecrm.com/oauth/token",
    callbackId: "capsule_crm",
    callbackUrl: "https://stella.sh/oauth/capsule_crm/callback",
    callbackMode: "external",
    scopes: ["read", "write", "user_preference"],
    resourceUrl: "https://api.capsulecrm.com/api/v2",
  },
  attio: {
    flow: "authorization_code",
    tokenKey: "native-oauth:attio",
    clientId: "cd8a51bd-be34-48a0-b236-bdf8130d0a88",
    authorizationEndpoint: "https://app.attio.com/authorize",
    tokenEndpoint: "https://app.attio.com/oauth/token",
    callbackId: "attio",
    callbackUrl: "https://stella.sh/oauth/attio/callback",
    callbackMode: "external",
    resourceUrl: "https://api.attio.com/v2",
    tokenExchange: { type: "backend", provider: "attio" },
  },
  eventbrite: {
    flow: "authorization_code",
    tokenKey: "native-oauth:eventbrite",
    clientId: "GJBYO7D2YQNH67QGI4",
    authorizationEndpoint: "https://www.eventbrite.com/oauth/authorize",
    tokenEndpoint: "https://www.eventbrite.com/oauth/token",
    callbackId: "eventbrite",
    callbackUrl: "https://stella.sh/oauth/eventbrite/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://www.eventbriteapi.com/v3",
    tokenExchange: { type: "backend", provider: "eventbrite" },
  },
  harvest: {
    flow: "authorization_code",
    tokenKey: "native-oauth:harvest",
    clientId: "tZFzTSymd5NcCejHSSZTk29T",
    authorizationEndpoint: "https://id.getharvest.com/oauth2/authorize",
    tokenEndpoint: "https://id.getharvest.com/api/v2/oauth2/token",
    callbackId: "harvest",
    callbackUrl: "https://stella.sh/oauth/harvest/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://api.harvestapp.com/v2",
    tokenExchange: { type: "backend", provider: "harvest" },
  },
  gumroad: {
    flow: "authorization_code",
    tokenKey: "native-oauth:gumroad",
    clientId: "N9ZACaOgSKV4bhslQbU96pMvzaaBi9KxjVQW_CWHS0g",
    authorizationEndpoint: "https://gumroad.com/oauth/authorize",
    tokenEndpoint: "https://api.gumroad.com/oauth/token",
    callbackId: "gumroad",
    callbackUrl: "https://stella.sh/oauth/gumroad/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://api.gumroad.com/v2",
    tokenExchange: { type: "backend", provider: "gumroad" },
  },
  freshbooks: {
    flow: "authorization_code",
    tokenKey: "native-oauth:freshbooks",
    clientId:
      "734fa3fa2ba4bbb42353a1499d4399d39fad0e56af2880ec3543d643d3215f07",
    authorizationEndpoint: "https://auth.freshbooks.com/oauth/authorize",
    tokenEndpoint: "https://api.freshbooks.com/auth/oauth/token",
    callbackId: "freshbooks",
    callbackUrl: "https://stella.sh/oauth/freshbooks/callback",
    callbackMode: "external",
    usesPkce: false,
    scopes: [
      "user:profile:read",
      "user:bills:read",
      "user:bills:write",
      "user:bill_payments:read",
      "user:bill_payments:write",
      "user:bill_vendors:read",
      "user:bill_vendors:write",
      "user:billable_items:read",
      "user:billable_items:write",
      "user:business:read",
      "user:business:write",
      "user:clients:read",
      "user:clients:write",
      "user:credit_notes:read",
      "user:credit_notes:write",
      "user:estimates:read",
      "user:estimates:write",
      "user:expenses:read",
      "user:expenses:write",
      "user:invoices:read",
      "user:invoices:write",
      "user:account:read",
      "user:account:write",
      "user:journal_entries:read",
      "user:journal_entries:write",
      "user:notifications:read",
      "user:online_payments:read",
      "user:online_payments:write",
      "user:other_income:read",
      "user:other_income:write",
      "user:payments:read",
      "user:payments:write",
      "user:projects:read",
      "user:projects:write",
      "user:reports:read",
      "user:retainers:read",
      "user:retainers:write",
      "user:taxes:read",
      "user:taxes:write",
      "user:teams:read",
      "user:teams:write",
      "user:time_entries:read",
      "user:time_entries:write",
      "user:uploads:read",
      "user:uploads:write",
      "user:riskhub:read",
      "user:riskhub:write",
    ],
    resourceUrl: "https://api.freshbooks.com",
    tokenExchange: { type: "backend", provider: "freshbooks" },
  },
  freeagent: {
    flow: "authorization_code",
    tokenKey: "native-oauth:freeagent",
    clientId: "Y9JvXQd2kyGfNTmUP0YWLA",
    authorizationEndpoint: "https://api.freeagent.com/v2/approve_app",
    tokenEndpoint: "https://api.freeagent.com/v2/token_endpoint",
    callbackId: "freeagent",
    callbackUrl: "https://stella.sh/oauth/freeagent/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://api.freeagent.com/v2",
    tokenAuth: "basic",
    tokenExchange: { type: "backend", provider: "freeagent" },
  },
  splitwise: {
    flow: "authorization_code",
    tokenKey: "native-oauth:splitwise",
    clientId: "xQP3b8G5azgUWhZaCrgGqsh9jXixUEBXNcpQaOIS",
    authorizationEndpoint: "https://secure.splitwise.com/oauth/authorize",
    tokenEndpoint: "https://secure.splitwise.com/oauth/token",
    callbackId: "splitwise",
    callbackUrl: "https://stella.sh/oauth/splitwise/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://secure.splitwise.com/api/v3.0",
    tokenExchange: { type: "backend", provider: "splitwise" },
  },
  stack_exchange: {
    flow: "authorization_code",
    tokenKey: "native-oauth:stack_exchange",
    clientId: "38651",
    authorizationEndpoint: "https://stackoverflow.com/oauth",
    tokenEndpoint: "https://stackoverflow.com/oauth/access_token/json",
    callbackId: "stack_exchange",
    callbackUrl: "https://stella.sh/oauth/stack_exchange/callback",
    callbackMode: "external",
    scopes: ["read_inbox", "private_info"],
    usesPkce: true,
    resourceUrl: "https://api.stackexchange.com/2.3",
    apiQueryParams: {
      key: "rl_sZoCA17hHm6xEGAJC2s6DqZPH",
      site: "stackoverflow",
    },
    apiAuthPlacement: "access_token_query",
  },
  zoom: {
    flow: "authorization_code",
    tokenKey: "native-oauth:zoom",
    clientId: "aH3dMgxKSte6Rj8CaJgymw",
    authorizationEndpoint: "https://zoom.us/oauth/authorize",
    tokenEndpoint: "https://zoom.us/oauth/token",
    callbackId: "zoom",
    callbackUrl: "https://stella.sh/oauth/zoom/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://api.zoom.us/v2",
    oauthResource: null,
    tokenAuth: "basic",
    tokenExchange: { type: "backend", provider: "zoom" },
  },
  pipedrive: {
    flow: "authorization_code",
    tokenKey: "native-oauth:pipedrive",
    clientId: "b8247eca296b4393",
    authorizationEndpoint: "https://oauth.pipedrive.com/oauth/authorize",
    tokenEndpoint: "https://oauth.pipedrive.com/oauth/token",
    callbackId: "pipedrive",
    callbackUrl: "https://stella.sh/oauth/pipedrive/callback",
    callbackMode: "external",
    usesPkce: false,
    resourceUrl: "https://api.pipedrive.com/v1",
    oauthResource: null,
    tokenAuth: "basic",
    tokenExchange: { type: "backend", provider: "pipedrive" },
  },
  crowdin: {
    flow: "authorization_code",
    tokenKey: "native-oauth:crowdin",
    clientId: "F1OAfz6IVsVlK7CUxTLG",
    authorizationEndpoint: "https://accounts.crowdin.com/oauth/authorize",
    tokenEndpoint: "https://accounts.crowdin.com/oauth/token",
    callbackId: "crowdin",
    callbackUrl: "https://stella.sh/oauth/crowdin/callback",
    callbackMode: "external",
    scopes: [
      "ai",
      "ai.fine-tuning",
      "ai.prompt",
      "ai.provider",
      "ai.proxy",
      "application",
      "field",
      "glossary",
      "language",
      "mt",
      "notification",
      "project",
      "project.member",
      "project.report",
      "project.screenshot",
      "project.settings",
      "project.source",
      "project.status",
      "project.task",
      "project.translation",
      "project.webhook",
      "security-log",
      "tm",
      "webhook",
    ],
    resourceUrl: "https://api.crowdin.com/api/v2",
    tokenExchange: { type: "backend", provider: "crowdin" },
  },
  dart: {
    flow: "authorization_code",
    tokenKey: "native-oauth:dart",
    clientId: "3UeVbdTf8L7LzYMPBXgbAWqHqEP4O4Zdfhy6UeVb",
    authorizationEndpoint: "https://app.dartai.com/api/oauth/authorize/",
    tokenEndpoint: "https://app.dartai.com/api/oauth/token/",
    callbackId: "dart",
    callbackUrl: "https://stella.sh/oauth/dart/callback",
    callbackMode: "external",
    scopes: ["read", "write"],
    usesPkce: true,
    resourceUrl: "https://app.dartai.com/api/v0/public",
  },
  supabase: {
    flow: "authorization_code",
    tokenKey: "native-oauth:supabase",
    clientId: "560813d3-7444-449f-b4be-599903181ad6",
    authorizationEndpoint: "https://api.supabase.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.supabase.com/v1/oauth/token",
    callbackId: "supabase",
    callbackUrl: "https://stella.sh/oauth/supabase/callback",
    callbackMode: "external",
    resourceUrl: "https://api.supabase.com",
    tokenAuth: "basic",
    tokenExchange: { type: "backend", provider: "supabase" },
  },
  stripe: {
    flow: "authorization_code",
    tokenKey: "native-oauth:stripe",
    clientId: "ca_UXR77uEpEHt3zNp9sLXx0WQKn2VPrjkp",
    authorizationEndpoint: "https://connect.stripe.com/oauth/authorize",
    tokenEndpoint: "https://connect.stripe.com/oauth/token",
    callbackId: "stripe",
    callbackUrl: "https://stella.sh/oauth/stripe/callback",
    callbackMode: "external",
    scopes: ["read_write"],
    usesPkce: false,
    resourceUrl: "https://api.stripe.com/v1",
    tokenExchange: { type: "backend", provider: "stripe" },
  },
  typeform: {
    flow: "authorization_code",
    tokenKey: "native-oauth:typeform",
    clientId: "Du2oKgzB7G5hZ6cg6sYb8tTAoWV7AaD1CdbXYBZpZbUL",
    authorizationEndpoint: "https://api.typeform.com/oauth/authorize",
    tokenEndpoint: "https://api.typeform.com/oauth/token",
    callbackId: "typeform",
    callbackUrl: "https://stella.sh/oauth/typeform/callback",
    callbackMode: "external",
    scopes: [
      "offline",
      "accounts:read",
      "forms:read",
      "forms:write",
      "images:read",
      "images:write",
      "responses:read",
      "responses:write",
      "themes:read",
      "themes:write",
      "webhooks:read",
      "webhooks:write",
      "workspaces:read",
      "workspaces:write",
    ],
    resourceUrl: "https://api.typeform.com",
    tokenExchange: { type: "backend", provider: "typeform" },
  },
  monday: {
    flow: "authorization_code",
    tokenKey: "native-oauth:monday",
    clientId: "4346e96f1d1a4e591e2651f5d14f5646",
    authorizationEndpoint: "https://auth.monday.com/oauth2/authorize",
    tokenEndpoint: "https://auth.monday.com/oauth2/token",
    callbackId: "monday",
    callbackUrl: "https://stella.sh/oauth/monday/callback",
    callbackMode: "external",
    scopes: [
      "me:read",
      "boards:read",
      "boards:write",
      "docs:read",
      "docs:write",
      "workspaces:read",
      "workspaces:write",
      "users:read",
      "users:write",
      "account:read",
      "notifications:write",
      "updates:read",
      "updates:write",
      "assets:read",
      "tags:read",
      "teams:read",
      "teams:write",
      "departments:read",
      "departments:write",
      "webhooks:write",
      "webhooks:read",
    ],
    authorizationParams: {
      app_version_id: "14744097",
      force_install_if_needed: "true",
    },
    resourceUrl: "https://api.monday.com/v2",
    tokenExchange: { type: "backend", provider: "monday" },
  },
  zeplin: {
    flow: "authorization_code",
    tokenKey: "native-oauth:zeplin",
    clientId: "6a0ad88ad38562e96173736e",
    authorizationEndpoint: "https://api.zeplin.dev/v1/oauth/authorize",
    tokenEndpoint: "https://api.zeplin.dev/v1/oauth/token",
    callbackId: "zeplin",
    callbackUrl: "https://stella.sh/oauth/zeplin/callback",
    callbackMode: "external",
    usesPkce: true,
    resourceUrl: "https://api.zeplin.dev/v1",
  },
};

export const isNativeOAuthProviderConfigReady = (
  id: string,
  config: NativeOAuthProviderConfig,
  options: NativeOAuthProviderConfigOptions = {},
) => {
  if (
    config.flow === "authorization_code" &&
    (config.responseType ?? "code") === "code" &&
    !config.tokenEndpoint
  ) {
    return false;
  }
  const provider = (config.tokenExchange?.provider ?? id).trim().toLowerCase();
  if (
    config.flow === "authorization_code" &&
    config.callbackMode === "external" &&
    !isHostedOAuthCallbackUrl(config.callbackUrl) &&
    !options.configuredExternalCallbackProviders?.has(provider) &&
    process.env[envKey(provider, "EXTERNAL_CALLBACK_READY")] !== "1" &&
    process.env[envKey(id, "EXTERNAL_CALLBACK_READY")] !== "1"
  ) {
    return false;
  }
  if (config.tokenExchange?.type !== "backend") return true;
  if (options.configuredBackendProviders?.has(provider)) return true;
  if (process.env[envKey(provider, "BACKEND_READY")] === "1") return true;
  return process.env[envKey(id, "BACKEND_READY")] === "1";
};

export const getNativeOAuthProviderConfig = (
  id: string,
): NativeOAuthProviderConfig | null => {
  const normalizedId = id.trim().toLowerCase();
  const builtin = BUILTIN_NATIVE_OAUTH[normalizedId];
  const clientId = process.env[envKey(id, "CLIENT_ID")]?.trim();
  const tokenEndpoint = process.env[envKey(id, "TOKEN_URL")]?.trim();
  const deviceAuthorizationEndpoint =
    process.env[envKey(id, "DEVICE_AUTHORIZATION_URL")]?.trim();
  if (clientId && tokenEndpoint && deviceAuthorizationEndpoint) {
    return {
      flow: "device",
      tokenKey: `native-oauth:${normalizedId}`,
      clientId,
      deviceAuthorizationEndpoint,
      tokenEndpoint,
      scopes: readEnvList(envKey(id, "SCOPES")),
      verificationUri:
        process.env[envKey(id, "VERIFICATION_URL")]?.trim() || undefined,
      resourceUrl: process.env[envKey(id, "RESOURCE_URL")]?.trim() || undefined,
      tokenExchange: readEnvTokenExchange(id, { type: "direct" }),
    };
  }
  const authorizationEndpoint =
    process.env[envKey(id, "AUTHORIZATION_URL")]?.trim();
  const responseType =
    process.env[envKey(id, "RESPONSE_TYPE")] === "token" ? "token" : "code";
  if (
    clientId &&
    authorizationEndpoint &&
    (tokenEndpoint || responseType === "token")
  ) {
    return {
      flow: "authorization_code",
      tokenKey: `native-oauth:${normalizedId}`,
      clientId,
      authorizationEndpoint,
      tokenEndpoint,
      responseType,
      scopes: readEnvList(envKey(id, "SCOPES")),
      usesPkce: readEnvUsesPkce(id),
      authorizationParams: readEnvJsonObject(
        envKey(id, "AUTHORIZATION_PARAMS_JSON"),
      ),
      tokenAuth: readEnvTokenAuth(id),
      callbackId: id,
      callbackUrl:
        process.env[envKey(id, "CALLBACK_URL")]?.trim() || DEFAULT_CALLBACK_URL,
      callbackMode:
        process.env[envKey(id, "CALLBACK_MODE")] === "external"
          ? "external"
          : "local",
      scopeSeparator: process.env[envKey(id, "SCOPE_SEPARATOR")] || undefined,
      resourceUrl: process.env[envKey(id, "RESOURCE_URL")]?.trim() || undefined,
      tokenExchange: readEnvTokenExchange(id, { type: "direct" }),
    };
  }
  const shared = readSharedOAuthProviderConfig(normalizedId);
  const envBacked = readEnvBackedOAuthProviderConfig(normalizedId);
  if (shared) return applyEnvOverrides(normalizedId, shared);
  if (envBacked) return applyEnvOverrides(normalizedId, envBacked);
  if (builtin) return applyEnvOverrides(normalizedId, builtin);
  return null;
};
