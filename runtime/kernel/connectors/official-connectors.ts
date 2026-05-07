import type { ApiConnectorConfig, ConnectorConfigField, ConnectorCommandConfig } from "./types.js";

export type OfficialConnectorDefinition = {
  marketplaceKey: string;
  displayName: string;
  status: "official-cli" | "official-api";
  officialSource?: string;
  integrationPath?: string;
  auth?: string;
  configFields?: ConnectorConfigField[];
  commands?: ConnectorCommandConfig[];
  apis?: ApiConnectorConfig[];
  notes?: string;
};

export const OFFICIAL_CONNECTOR_DEFINITIONS: OfficialConnectorDefinition[] = [
  {
    marketplaceKey: "alpaca",
    displayName: "Alpaca",
    status: "official-cli",
    officialSource: "https://docs.alpaca.markets/docs/alpaca-mcp-server",
    integrationPath: "Official local/self-hosted MCP server",
    auth: "Alpaca Trading API keys",
    configFields: [
      { key: "ALPACA_API_KEY", label: "Alpaca API key", secret: true },
      { key: "ALPACA_SECRET_KEY", label: "Alpaca secret key", secret: true },
    ],
    notes:
      "Remote hosting is not yet available from Alpaca; Stella should run the official server locally or point at a user-hosted endpoint.",
    commands: [
      {
        id: "alpaca",
        displayName: "Alpaca",
        description: "Trade and analyze stocks, ETFs, crypto, options, portfolios, orders, watchlists, and market data.",
        transport: "stdio",
        command: "uvx",
        args: ["alpaca-mcp-server"],
        env: {
          ALPACA_API_KEY: "${ALPACA_API_KEY}",
          ALPACA_SECRET_KEY: "${ALPACA_SECRET_KEY}",
        },
        auth: { type: "none" },
        source: {
          marketplaceKey: "alpaca",
          officialUrl: "https://github.com/alpacahq/alpaca-mcp-server",
        },
      },
    ],
  },
{
    marketplaceKey: "amplitude",
    displayName: "Amplitude",
    status: "official-cli",
    officialSource: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "amplitude-us",
        displayName: "Amplitude",
        description: "Analyze Amplitude product data, charts, dashboards, cohorts, and experiments.",
        transport: "streamable_http",
        url: "https://mcp.amplitude.com/mcp",
        auth: { type: "oauth", tokenKey: "amplitude-us" },
        source: {
          marketplaceKey: "amplitude",
          officialUrl: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
        },
      },
      {
        id: "amplitude-eu",
        displayName: "Amplitude EU",
        description: "Analyze Amplitude EU-residency product data.",
        transport: "streamable_http",
        url: "https://mcp.eu.amplitude.com/mcp",
        auth: { type: "oauth", tokenKey: "amplitude-eu" },
        source: {
          marketplaceKey: "amplitude",
          officialUrl: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "atlassian-rovo",
    displayName: "Atlassian Rovo",
    status: "official-cli",
    officialSource:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth 2.1 or admin-enabled API token",
    commands: [
      {
        id: "atlassian-rovo",
        displayName: "Atlassian Rovo",
        description: "Access Jira, Confluence, and Compass data through Atlassian Rovo MCP.",
        transport: "streamable_http",
        url: "https://mcp.atlassian.com/v1/mcp",
        auth: { type: "oauth", tokenKey: "atlassian-rovo" },
        source: {
          marketplaceKey: "atlassian-rovo",
          officialUrl:
            "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
        },
      },
    ],
  },
{
    marketplaceKey: "attio",
    displayName: "Attio",
    status: "official-cli",
    officialSource: "https://docs.attio.com/mcp/overview",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "attio",
        displayName: "Attio",
        description: "Search, create, and update Attio CRM records, notes, tasks, meetings, emails, and reports.",
        transport: "streamable_http",
        url: "https://mcp.attio.com/mcp",
        auth: { type: "oauth", tokenKey: "attio" },
        source: {
          marketplaceKey: "attio",
          officialUrl: "https://docs.attio.com/mcp/overview",
        },
      },
    ],
  },
{
    marketplaceKey: "binance",
    displayName: "Binance",
    status: "official-api",
    officialSource: "https://developers.binance.com/docs/binance-spot-api-docs",
    integrationPath: "Official Binance APIs; no official Binance MCP found in the first pass",
    auth: "Binance API key/secret",
    apis: [
      {
        id: "binance",
        displayName: "Binance",
        description: "Call Binance Spot REST API endpoints.",
        baseUrl: "https://api.binance.com",
        auth: { type: "api_key", tokenKey: "binance", headerName: "X-MBX-APIKEY", scheme: "raw" },
        source: {
          marketplaceKey: "binance",
          officialUrl: "https://developers.binance.com/docs/binance-spot-api-docs",
        },
      },
    ],
  },
{
    marketplaceKey: "biorender",
    displayName: "BioRender",
    status: "official-cli",
    officialSource:
      "https://help.biorender.com/hc/en-gb/articles/30870978672157-How-to-use-the-BioRender-MCP-connector",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "biorender",
        displayName: "BioRender",
        description: "Search BioRender icons and templates from Stella.",
        transport: "streamable_http",
        url: "https://mcp.services.biorender.com/mcp",
        auth: { type: "oauth", tokenKey: "biorender" },
        source: {
          marketplaceKey: "biorender",
          officialUrl:
            "https://help.biorender.com/hc/en-gb/articles/30870978672157-How-to-use-the-BioRender-MCP-connector",
        },
      },
    ],
  },
{
    marketplaceKey: "box",
    displayName: "Box",
    status: "official-cli",
    officialSource: "https://developer.box.com/guides/box-mcp/remote/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "box",
        displayName: "Box",
        description: "Search and work with Box content through Box MCP.",
        transport: "streamable_http",
        url: "https://mcp.box.com",
        auth: { type: "oauth", tokenKey: "box" },
        source: {
          marketplaceKey: "box",
          officialUrl: "https://developer.box.com/guides/box-mcp/remote/",
        },
      },
    ],
  },
{
    marketplaceKey: "brand24",
    displayName: "Brand24",
    status: "official-cli",
    officialSource: "https://help.brand24.com/en/articles/13011375-brand24-mcp",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "brand24",
        displayName: "Brand24",
        description: "Query current Brand24 social listening project insights.",
        transport: "streamable_http",
        url: "https://mcp.brand24.com/v1/mcp",
        auth: { type: "oauth", tokenKey: "brand24" },
        source: {
          marketplaceKey: "brand24",
          officialUrl: "https://help.brand24.com/en/articles/13011375-brand24-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "canva",
    displayName: "Canva",
    status: "official-cli",
    officialSource: "https://www.canva.dev/docs/mcp/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth with Dynamic Client Registration; redirect URI allowlist required",
    commands: [
      {
        id: "canva",
        displayName: "Canva",
        description: "Create, edit, search, export, and comment on Canva designs.",
        transport: "streamable_http",
        url: "https://mcp.canva.com/mcp",
        auth: { type: "oauth", tokenKey: "canva" },
        source: {
          marketplaceKey: "canva",
          officialUrl: "https://www.canva.dev/docs/mcp/",
        },
      },
    ],
  },
{
    marketplaceKey: "circleback",
    displayName: "Circleback",
    status: "official-cli",
    officialSource: "https://support.circleback.ai/en/articles/13249081-circleback-mcp",
    integrationPath: "Official remote MCP server",
    auth: "OAuth with Dynamic Client Registration",
    commands: [
      {
        id: "circleback",
        displayName: "Circleback",
        description: "Search meetings, transcripts, calendar events, emails, people, and companies.",
        transport: "streamable_http",
        url: "https://app.circleback.ai/api/mcp",
        auth: { type: "oauth", tokenKey: "circleback" },
        source: {
          marketplaceKey: "circleback",
          officialUrl: "https://support.circleback.ai/en/articles/13249081-circleback-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "clickup",
    displayName: "ClickUp",
    status: "official-cli",
    officialSource: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "clickup",
        displayName: "ClickUp",
        description: "Search and manage ClickUp tasks, docs, comments, chat, time tracking, and workspace hierarchy.",
        transport: "streamable_http",
        url: "https://mcp.clickup.com/mcp",
        auth: { type: "oauth", tokenKey: "clickup" },
        source: {
          marketplaceKey: "clickup",
          officialUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1",
        },
      },
    ],
  },
{
    marketplaceKey: "cloudflare",
    displayName: "Cloudflare",
    status: "official-cli",
    officialSource:
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth or Cloudflare API token",
    commands: [
      {
        id: "cloudflare-api",
        displayName: "Cloudflare API",
        description: "Search and execute Cloudflare API operations across DNS, Workers, R2, Zero Trust, and more.",
        transport: "streamable_http",
        url: "https://mcp.cloudflare.com/mcp",
        auth: { type: "oauth", tokenKey: "cloudflare-api" },
        source: {
          marketplaceKey: "cloudflare",
          officialUrl:
            "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
        },
      },
    ],
  },
{
    marketplaceKey: "cloudinary",
    displayName: "Cloudinary",
    status: "official-cli",
    officialSource: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
    integrationPath: "Official remote MCP servers",
    auth: "OAuth or Cloudinary API credentials via headers",
    commands: [
      {
        id: "cloudinary-asset-mgmt",
        displayName: "Cloudinary Asset Management",
        description: "Upload, manage, transform, search, delete, and organize Cloudinary assets.",
        transport: "streamable_http",
        url: "https://asset-management.mcp.cloudinary.com/mcp",
        auth: { type: "oauth", tokenKey: "cloudinary-asset-mgmt" },
        source: {
          marketplaceKey: "cloudinary",
          officialUrl: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
        },
      },
      {
        id: "cloudinary-env-config",
        displayName: "Cloudinary Environment Config",
        description: "Configure Cloudinary product environment settings.",
        transport: "streamable_http",
        url: "https://environment-config.mcp.cloudinary.com/mcp",
        auth: { type: "oauth", tokenKey: "cloudinary-env-config" },
        source: {
          marketplaceKey: "cloudinary",
          officialUrl: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
        },
      },
      {
        id: "cloudinary-smd",
        displayName: "Cloudinary Structured Metadata",
        description: "Create and manage Cloudinary structured metadata.",
        transport: "streamable_http",
        url: "https://structured-metadata.mcp.cloudinary.com/mcp",
        auth: { type: "oauth", tokenKey: "cloudinary-smd" },
        source: {
          marketplaceKey: "cloudinary",
          officialUrl: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
        },
      },
      {
        id: "cloudinary-analysis",
        displayName: "Cloudinary Analysis",
        description: "Analyze Cloudinary media assets.",
        transport: "streamable_http",
        url: "https://analysis.mcp.cloudinary.com/sse",
        auth: { type: "oauth", tokenKey: "cloudinary-analysis" },
        source: {
          marketplaceKey: "cloudinary",
          officialUrl: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "common-room",
    displayName: "Common Room",
    status: "official-cli",
    officialSource: "https://www.commonroom.io/docs/using-common-room/mcp-server/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth 2.1",
    commands: [
      {
        id: "common-room",
        displayName: "Common Room",
        description: "Research accounts, prep calls, build prospect lists, and draft outreach from Common Room GTM data.",
        transport: "streamable_http",
        url: "https://mcp.commonroom.io/mcp",
        auth: { type: "oauth", tokenKey: "common-room" },
        source: {
          marketplaceKey: "common-room",
          officialUrl: "https://www.commonroom.io/docs/using-common-room/mcp-server/",
        },
      },
    ],
  },
{
    marketplaceKey: "conductor",
    displayName: "Conductor",
    status: "official-cli",
    officialSource: "https://docs.conductor.is/usage/mcp",
    integrationPath: "Official local MCP server",
    auth: "Conductor secret key",
    configFields: [
      { key: "CONDUCTOR_SECRET_KEY", label: "Conductor secret key", secret: true },
    ],
    commands: [
      {
        id: "conductor",
        displayName: "Conductor",
        description: "Read and write QuickBooks Desktop data through Conductor APIs.",
        transport: "stdio",
        command: "npx",
        args: ["-y", "conductor-node-mcp@latest"],
        env: {
          CONDUCTOR_SECRET_KEY: "${CONDUCTOR_SECRET_KEY}",
        },
        auth: { type: "none" },
        source: {
          marketplaceKey: "conductor",
          officialUrl: "https://docs.conductor.is/usage/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "coupler-io",
    displayName: "Coupler.io",
    status: "official-cli",
    officialSource: "https://www.coupler.io/mcp",
    integrationPath: "Official MCP; server URL is configured inside Coupler.io",
    auth: "Coupler.io account and personal access token",
    configFields: [
      { key: "COUPLER_MCP_URL", label: "Coupler.io MCP URL", placeholder: "https://..." },
    ],
    commands: [
      {
        id: "coupler-io",
        displayName: "Coupler.io",
        description: "Analyze data connected through Coupler.io MCP.",
        transport: "streamable_http",
        url: "${COUPLER_MCP_URL}",
        auth: { type: "none" },
        source: {
          marketplaceKey: "coupler-io",
          officialUrl: "https://www.coupler.io/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "coveo",
    displayName: "Coveo",
    status: "official-cli",
    officialSource: "https://docs.coveo.com/en/q1mb0212/",
    integrationPath: "Official hosted MCP server",
    auth: "OAuth or anonymous API key",
    commands: [
      {
        id: "coveo",
        displayName: "Coveo",
        description: "Search, fetch, answer, and retrieve passages from Coveo indexed content.",
        transport: "streamable_http",
        url: "https://mcp.cloud.coveo.com/mcp",
        auth: { type: "oauth", tokenKey: "coveo" },
        source: {
          marketplaceKey: "coveo",
          officialUrl: "https://docs.coveo.com/en/q1mb0212/",
        },
      },
    ],
  },
{
    marketplaceKey: "cube",
    displayName: "Cube",
    status: "official-cli",
    officialSource: "https://cube.dev/docs/product/apis-integrations/mcp-server",
    integrationPath: "Official tenant remote MCP server",
    auth: "OAuth with tenant-specific endpoint",
    configFields: [
      { key: "CUBE_MCP_URL", label: "Cube MCP URL", placeholder: "https://<host>/api/mcp" },
    ],
    commands: [
      {
        id: "cube",
        displayName: "Cube",
        description: "Query Cube semantic-layer context through the tenant MCP endpoint.",
        transport: "streamable_http",
        url: "${CUBE_MCP_URL}",
        auth: { type: "oauth", tokenKey: "cube" },
        source: {
          marketplaceKey: "cube",
          officialUrl: "https://cube.dev/docs/product/apis-integrations/mcp-server",
        },
      },
    ],
  },
{
    marketplaceKey: "daloopa",
    displayName: "Daloopa",
    status: "official-cli",
    officialSource: "https://docs.daloopa.com/docs/daloopa-mcp",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "daloopa",
        displayName: "Daloopa",
        description: "Discover companies and financial series, fetch fundamentals, and search financial documents.",
        transport: "streamable_http",
        url: "https://mcp.daloopa.com/server/mcp",
        auth: { type: "oauth", tokenKey: "daloopa" },
        source: {
          marketplaceKey: "daloopa",
          officialUrl: "https://docs.daloopa.com/docs/daloopa-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "domotz-preview",
    displayName: "Domotz (Preview)",
    status: "official-cli",
    officialSource: "https://help.domotz.com/integrations/domotz-mcp-server-setup/",
    integrationPath: "Official remote MCP server",
    auth: "Domotz account; beta access required",
    commands: [
      {
        id: "domotz-prod",
        displayName: "Domotz",
        description: "Network monitoring and management through Domotz MCP.",
        transport: "streamable_http",
        url: "https://mcp.ov.domotz.app/mcp",
        auth: { type: "oauth", tokenKey: "domotz-prod" },
        source: {
          marketplaceKey: "domotz-preview",
          officialUrl: "https://help.domotz.com/integrations/domotz-mcp-server-setup/",
        },
      },
    ],
  },
{
    marketplaceKey: "dovetail",
    displayName: "Dovetail",
    status: "official-cli",
    officialSource: "https://developers.dovetail.com/docs/mcp",
    integrationPath: "Official hosted MCP server",
    auth: "OAuth or Dovetail API token",
    commands: [
      {
        id: "dovetail",
        displayName: "Dovetail",
        description: "Search Dovetail workspaces and retrieve projects, insights, highlights, and data content.",
        transport: "streamable_http",
        url: "https://dovetail.com/api/mcp",
        auth: { type: "oauth", tokenKey: "dovetail" },
        source: {
          marketplaceKey: "dovetail",
          officialUrl: "https://developers.dovetail.com/docs/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "egnyte",
    displayName: "Egnyte",
    status: "official-cli",
    officialSource:
      "https://helpdesk.egnyte.com/hc/en-us/articles/43305899030797-Egnyte-Remote-MCP-Server-Overview",
    integrationPath: "Official remote MCP server",
    auth: "Egnyte OAuth 2.0",
    commands: [
      {
        id: "egnyte",
        displayName: "Egnyte",
        description: "Search, retrieve, and summarize Egnyte files while respecting Egnyte permissions.",
        transport: "streamable_http",
        url: "https://mcp-server.egnyte.com/mcp",
        auth: { type: "oauth", tokenKey: "egnyte" },
        source: {
          marketplaceKey: "egnyte",
          officialUrl:
            "https://helpdesk.egnyte.com/hc/en-us/articles/45047859795341-Egnyte-MCP-Server-Connecting-Egnyte-to-Microsoft-Copilot-Studio",
        },
      },
    ],
  },
{
    marketplaceKey: "figma",
    displayName: "Figma",
    status: "official-cli",
    officialSource:
      "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server",
    integrationPath: "Official Figma Dev Mode local MCP server",
    auth: "Figma Desktop app, paid Dev or Full seat for desktop server",
    commands: [
      {
        id: "figma-dev-mode",
        displayName: "Figma Dev Mode",
        description: "Read selected Figma design context from the Figma Desktop Dev Mode MCP server.",
        transport: "streamable_http",
        url: "http://127.0.0.1:3845/mcp",
        auth: { type: "none" },
        source: {
          marketplaceKey: "figma",
          officialUrl:
            "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server",
        },
      },
    ],
  },
{
    marketplaceKey: "github",
    displayName: "GitHub",
    status: "official-cli",
    officialSource: "https://docs.github.com/en/copilot/concepts/context/copilot-extensions",
    integrationPath: "Official remote GitHub MCP server",
    auth: "GitHub OAuth/Copilot auth",
    commands: [
      {
        id: "github",
        displayName: "GitHub",
        description: "Work with GitHub repositories, issues, pull requests, code search, and related resources.",
        transport: "streamable_http",
        url: "https://api.githubcopilot.com/mcp",
        auth: { type: "oauth", tokenKey: "github" },
        source: {
          marketplaceKey: "github",
          officialUrl: "https://docs.github.com/en/copilot/concepts/context/copilot-extensions",
        },
      },
    ],
  },
{
    marketplaceKey: "gmail",
    displayName: "Gmail",
    status: "official-api",
    officialSource: "https://developers.google.com/gmail/api/guides",
    integrationPath: "Official Gmail API; no official Google-hosted Gmail MCP found in first pass",
    auth: "Google OAuth",
    apis: [
      {
        id: "gmail",
        displayName: "Gmail",
        description: "Call Gmail API endpoints.",
        baseUrl: "https://gmail.googleapis.com",
        auth: { type: "oauth", tokenKey: "gmail", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "gmail", officialUrl: "https://developers.google.com/gmail/api/guides" },
      },
    ],
    notes: "Stella also has a first-class Google Workspace runtime path; this API adapter supports direct REST calls when a token is provided.",
  },
{
    marketplaceKey: "google-calendar",
    displayName: "Google Calendar",
    status: "official-api",
    officialSource: "https://developers.google.com/calendar/api/guides/overview",
    integrationPath: "Official Google Calendar API; no official Google-hosted Calendar MCP found in first pass",
    auth: "Google OAuth",
    apis: [
      {
        id: "google-calendar",
        displayName: "Google Calendar",
        description: "Call Google Calendar API endpoints.",
        baseUrl: "https://www.googleapis.com/calendar/v3",
        auth: { type: "oauth", tokenKey: "google-calendar", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "google-calendar", officialUrl: "https://developers.google.com/calendar/api/guides/overview" },
      },
    ],
    notes: "Stella also has a first-class Google Workspace runtime path; this API adapter supports direct REST calls when a token is provided.",
  },
{
    marketplaceKey: "google-drive",
    displayName: "Google Drive",
    status: "official-api",
    officialSource: "https://developers.google.com/drive/api/guides/about-sdk",
    integrationPath: "Official Google Drive API; no official Google-hosted Drive MCP found in first pass",
    auth: "Google OAuth",
    apis: [
      {
        id: "google-drive",
        displayName: "Google Drive",
        description: "Call Google Drive API endpoints.",
        baseUrl: "https://www.googleapis.com/drive/v3",
        auth: { type: "oauth", tokenKey: "google-drive", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "google-drive", officialUrl: "https://developers.google.com/drive/api/guides/about-sdk" },
      },
    ],
    notes: "Stella also has a first-class Google Workspace runtime path; this API adapter supports direct REST calls when a token is provided.",
  },
{
    marketplaceKey: "granola",
    displayName: "Granola",
    status: "official-cli",
    officialSource: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
    integrationPath: "Official remote MCP server",
    auth: "Granola browser OAuth 2.0 with DCR",
    commands: [
      {
        id: "granola",
        displayName: "Granola",
        description: "Search Granola meeting notes, folders, transcripts, action items, and meeting insights.",
        transport: "streamable_http",
        url: "https://mcp.granola.ai/mcp",
        auth: { type: "oauth", tokenKey: "granola" },
        source: {
          marketplaceKey: "granola",
          officialUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "fireflies",
    displayName: "Fireflies",
    status: "official-cli",
    officialSource: "https://docs.fireflies.ai/mcp-tools/overview",
    integrationPath: "Official remote MCP server",
    auth: "OAuth or Fireflies API key",
    commands: [
      {
        id: "fireflies",
        displayName: "Fireflies",
        description: "Search and retrieve Fireflies meeting transcripts, summaries, and user data.",
        transport: "streamable_http",
        url: "https://api.fireflies.ai/mcp",
        auth: { type: "oauth", tokenKey: "fireflies" },
        source: {
          marketplaceKey: "fireflies",
          officialUrl: "https://docs.fireflies.ai/mcp-tools/overview",
        },
      },
      {
        id: "fireflies-docs",
        displayName: "Fireflies Docs",
        description: "Search Fireflies API documentation, guides, and examples.",
        transport: "streamable_http",
        url: "https://docs.fireflies.ai/mcp",
        source: {
          marketplaceKey: "fireflies",
          officialUrl: "https://docs.fireflies.ai/getting-started/docs-mcp-server",
        },
      },
    ],
  },
{
    marketplaceKey: "hubspot",
    displayName: "HubSpot",
    status: "official-cli",
    officialSource: "https://developers.hubspot.com/mcp",
    integrationPath: "Official remote MCP plus official local Developer MCP via HubSpot CLI",
    auth: "HubSpot OAuth; local CLI auth for Developer MCP",
    commands: [
      {
        id: "hubspot",
        displayName: "HubSpot",
        description: "Access HubSpot CRM data through HubSpot's remote MCP server.",
        transport: "streamable_http",
        url: "https://mcp.hubspot.com",
        auth: { type: "oauth", tokenKey: "hubspot" },
        source: {
          marketplaceKey: "hubspot",
          officialUrl: "https://developers.hubspot.com/mcp",
        },
      },
      {
        id: "hubspot-dev",
        displayName: "HubSpot Developer MCP",
        description: "Use HubSpot developer tooling and CMS/app development helpers through the HubSpot CLI.",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@hubspot/cli", "mcp", "server"],
        source: {
          marketplaceKey: "hubspot",
          officialUrl:
            "https://developers.hubspot.com/docs/developer-tooling/local-development/developer-mcp/setup",
        },
      },
    ],
  },
{
    marketplaceKey: "help-scout",
    displayName: "Help Scout",
    status: "official-api",
    officialSource: "https://developer.helpscout.com/mailbox-api/overview/authentication",
    integrationPath: "Official Help Scout Mailbox/Docs APIs; no official first-party MCP found in first pass",
    auth: "Help Scout OAuth 2.0 or Docs API key",
    apis: [
      {
        id: "help-scout",
        displayName: "Help Scout",
        description: "Call Help Scout Mailbox API endpoints.",
        baseUrl: "https://api.helpscout.net",
        auth: { type: "api_key", tokenKey: "help-scout", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "help-scout",
          officialUrl: "https://developer.helpscout.com/mailbox-api/overview/authentication",
        },
      },
    ],
  },
{
    marketplaceKey: "highlevel",
    displayName: "HighLevel",
    status: "official-cli",
    officialSource: "https://marketplace.gohighlevel.com/docs/other/mcp/index.html",
    integrationPath: "Official remote MCP server",
    auth: "HighLevel Private Integration Token plus optional locationId",
    commands: [
      {
        id: "highlevel",
        displayName: "HighLevel",
        description: "Access HighLevel calendars, contacts, conversations, opportunities, payments, social posts, blogs, and email templates.",
        transport: "streamable_http",
        url: "https://services.leadconnectorhq.com/mcp/",
        auth: {
          type: "api_key",
          tokenKey: "highlevel",
          headerName: "Authorization",
        },
        source: {
          marketplaceKey: "highlevel",
          officialUrl: "https://marketplace.gohighlevel.com/docs/other/mcp/index.html",
        },
      },
    ],
  },
{
    marketplaceKey: "hostinger",
    displayName: "Hostinger",
    status: "official-cli",
    officialSource: "https://support.hostinger.com/en/articles/11079316-hostinger-api-mcp-server",
    integrationPath: "Official local MCP server via hostinger-api-mcp",
    auth: "Hostinger API token",
    configFields: [
      { key: "HOSTINGER_API_TOKEN", label: "Hostinger API token", secret: true },
    ],
    commands: [
      {
        id: "hostinger",
        displayName: "Hostinger",
        description: "Manage Hostinger hosting and infrastructure through the Hostinger Developer API.",
        transport: "stdio",
        command: "npx",
        args: ["-y", "hostinger-api-mcp"],
        env: {
          DEBUG: "false",
          HOSTINGER_API_TOKEN: "${HOSTINGER_API_TOKEN}",
        },
        source: {
          marketplaceKey: "hostinger",
          officialUrl: "https://support.hostinger.com/en/articles/11079316-hostinger-api-mcp-server",
        },
      },
    ],
  },
{
    marketplaceKey: "hugging-face",
    displayName: "Hugging Face",
    status: "official-cli",
    officialSource: "https://huggingface.co/docs/hub/agents-mcp",
    integrationPath: "Official hosted MCP server",
    auth: "Hugging Face account/OAuth from MCP settings",
    commands: [
      {
        id: "hugging-face",
        displayName: "Hugging Face",
        description: "Search Hugging Face Hub models, datasets, Spaces, papers, docs, and enabled MCP Spaces.",
        transport: "streamable_http",
        url: "https://huggingface.co/mcp",
        auth: { type: "oauth", tokenKey: "hugging-face" },
        source: {
          marketplaceKey: "hugging-face",
          officialUrl: "https://huggingface.co/docs/hub/agents-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "jam",
    displayName: "Jam",
    status: "official-cli",
    officialSource: "https://jam.dev/docs/debug-a-jam/mcp",
    integrationPath: "Official remote MCP server",
    auth: "Jam OAuth",
    commands: [
      {
        id: "jam",
        displayName: "Jam",
        description: "Load Jam recordings, logs, screenshots, user events, metadata, comments, and folders.",
        transport: "streamable_http",
        url: "https://mcp.jam.dev/mcp",
        auth: { type: "oauth", tokenKey: "jam" },
        source: {
          marketplaceKey: "jam",
          officialUrl: "https://jam.dev/docs/debug-a-jam/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "linear",
    displayName: "Linear",
    status: "official-cli",
    officialSource: "https://linear.app/docs/mcp",
    integrationPath: "Official remote MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "linear",
        displayName: "Linear",
        description: "Access Linear issues, projects, teams, documents, comments, and workflow data.",
        transport: "streamable_http",
        url: "https://mcp.linear.app/mcp",
        auth: { type: "oauth", tokenKey: "linear" },
        source: {
          marketplaceKey: "linear",
          officialUrl: "https://linear.app/docs/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "monday-com",
    displayName: "Monday.com",
    status: "official-cli",
    officialSource: "https://support.monday.com/hc/en-us/articles/29491651933074-Connect-monday-MCP-with-ChatGPT",
    integrationPath: "Official hosted MCP server",
    auth: "monday.com OAuth; workspace MCP app install required",
    commands: [
      {
        id: "monday-com",
        displayName: "Monday.com",
        description: "Work with monday.com boards, items, docs, updates, activity, users, and workspace data.",
        transport: "streamable_http",
        url: "https://mcp.monday.com/mcp",
        auth: { type: "oauth", tokenKey: "monday-com" },
        source: {
          marketplaceKey: "monday-com",
          officialUrl:
            "https://support.monday.com/hc/en-us/articles/29491651933074-Connect-monday-MCP-with-ChatGPT",
        },
      },
    ],
  },
{
    marketplaceKey: "mem",
    displayName: "Mem",
    status: "official-cli",
    officialSource: "https://docs.mem.ai/mcp/setup",
    integrationPath: "Official remote MCP server",
    auth: "Mem OAuth",
    commands: [
      {
        id: "mem",
        displayName: "Mem",
        description: "Read, create, search, update, and organize Mem notes and collections.",
        transport: "streamable_http",
        url: "https://mcp.mem.ai/mcp",
        auth: { type: "oauth", tokenKey: "mem" },
        source: {
          marketplaceKey: "mem",
          officialUrl: "https://docs.mem.ai/mcp/setup",
        },
      },
    ],
  },
{
    marketplaceKey: "motherduck",
    displayName: "MotherDuck",
    status: "official-cli",
    officialSource: "https://motherduck.com/docs/sql-reference/mcp/",
    integrationPath: "Official remote MCP server",
    auth: "MotherDuck OAuth",
    commands: [
      {
        id: "motherduck",
        displayName: "MotherDuck",
        description: "Explore MotherDuck schemas, query data, search catalog metadata, and ask MotherDuck docs questions.",
        transport: "streamable_http",
        url: "https://api.motherduck.com/mcp",
        auth: { type: "oauth", tokenKey: "motherduck" },
        source: {
          marketplaceKey: "motherduck",
          officialUrl: "https://motherduck.com/docs/sql-reference/mcp/",
        },
      },
    ],
  },
{
    marketplaceKey: "neon-postgres",
    displayName: "Neon Postgres",
    status: "official-cli",
    officialSource: "https://mcp.neon.tech/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth/API key via Neon",
    commands: [
      {
        id: "neon-postgres",
        displayName: "Neon Postgres",
        description: "Manage Neon Postgres projects, branches, databases, queries, and migrations.",
        transport: "streamable_http",
        url: "https://mcp.neon.tech/mcp",
        auth: { type: "oauth", tokenKey: "neon-postgres" },
        source: {
          marketplaceKey: "neon-postgres",
          officialUrl: "https://mcp.neon.tech/",
        },
      },
    ],
  },
{
    marketplaceKey: "notion",
    displayName: "Notion",
    status: "official-cli",
    officialSource: "https://developers.notion.com/docs/get-started-with-mcp",
    integrationPath: "Official hosted MCP server",
    auth: "OAuth",
    commands: [
      {
        id: "notion",
        displayName: "Notion",
        description: "Read and write Notion pages, databases, tasks, and workspace content.",
        transport: "streamable_http",
        url: "https://mcp.notion.com/mcp",
        auth: { type: "oauth", tokenKey: "notion" },
        source: {
          marketplaceKey: "notion",
          officialUrl: "https://developers.notion.com/docs/get-started-with-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "netlify",
    displayName: "Netlify",
    status: "official-cli",
    officialSource: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    integrationPath: "Official local MCP server via @netlify/mcp",
    auth: "Netlify CLI login or NETLIFY_PERSONAL_ACCESS_TOKEN",
    commands: [
      {
        id: "netlify",
        displayName: "Netlify",
        description: "Create, manage, deploy, and configure Netlify projects, teams, forms, extensions, and environment variables.",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@netlify/mcp"],
        source: {
          marketplaceKey: "netlify",
          officialUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
        },
      },
    ],
  },
{
    marketplaceKey: "outlook-calendar",
    displayName: "Outlook Calendar",
    status: "official-api",
    officialSource: "https://learn.microsoft.com/en-us/graph/api/resources/calendar",
    integrationPath: "Official Microsoft Graph Calendar API; no standalone official Outlook Calendar MCP found in first pass",
    auth: "Microsoft OAuth",
    apis: [
      {
        id: "outlook-calendar",
        displayName: "Outlook Calendar",
        description: "Call Microsoft Graph calendar endpoints.",
        baseUrl: "https://graph.microsoft.com/v1.0",
        auth: { type: "oauth", tokenKey: "outlook-calendar", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "outlook-calendar", officialUrl: "https://learn.microsoft.com/en-us/graph/api/resources/calendar" },
      },
    ],
  },
{
    marketplaceKey: "outlook-email",
    displayName: "Outlook Email",
    status: "official-api",
    officialSource: "https://learn.microsoft.com/en-us/graph/api/resources/message",
    integrationPath: "Official Microsoft Graph Mail API; no standalone official Outlook Email MCP found in first pass",
    auth: "Microsoft OAuth",
    apis: [
      {
        id: "outlook-email",
        displayName: "Outlook Email",
        description: "Call Microsoft Graph mail endpoints.",
        baseUrl: "https://graph.microsoft.com/v1.0",
        auth: { type: "oauth", tokenKey: "outlook-email", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "outlook-email", officialUrl: "https://learn.microsoft.com/en-us/graph/api/resources/message" },
      },
    ],
  },
{
    marketplaceKey: "omni-analytics",
    displayName: "Omni Analytics",
    status: "official-cli",
    officialSource: "https://docs-legacy.omni.co/docs/ai/mcp",
    integrationPath: "Official tenant-scoped MCP: `https://<YOUR-OMNI-INSTANCE>/mcp/https`",
    auth: "Omni API key plus model/topic headers",
    configFields: [
      { key: "OMNI_MCP_URL", label: "Omni MCP URL", placeholder: "https://<instance>/mcp/https" },
      { key: "OMNI_API_KEY", label: "Omni API key", secret: true },
    ],
    commands: [
      {
        id: "omni-analytics",
        displayName: "Omni Analytics",
        description: "Query Omni semantic models and analytics topics through an Omni tenant MCP endpoint.",
        transport: "streamable_http",
        url: "${OMNI_MCP_URL}",
        headers: {
          Authorization: "Bearer ${OMNI_API_KEY}",
        },
        auth: { type: "none" },
        source: {
          marketplaceKey: "omni-analytics",
          officialUrl: "https://docs-legacy.omni.co/docs/ai/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "otter-ai",
    displayName: "Otter.ai",
    status: "official-cli",
    officialSource: "https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server",
    integrationPath: "Official remote MCP server",
    auth: "Otter OAuth",
    commands: [
      {
        id: "otter-ai",
        displayName: "Otter.ai",
        description: "Search Otter meetings, fetch transcripts, and retrieve authenticated user info.",
        transport: "streamable_http",
        url: "https://mcp.otter.ai/mcp",
        auth: { type: "oauth", tokenKey: "otter-ai" },
        source: {
          marketplaceKey: "otter-ai",
          officialUrl: "https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server",
        },
      },
    ],
  },
{
    marketplaceKey: "sharepoint",
    displayName: "SharePoint",
    status: "official-api",
    officialSource: "https://learn.microsoft.com/en-us/graph/api/resources/sharepoint",
    integrationPath: "Official Microsoft Graph SharePoint API; no standalone official SharePoint MCP found in first pass",
    auth: "Microsoft OAuth",
    apis: [
      {
        id: "sharepoint",
        displayName: "SharePoint",
        description: "Call Microsoft Graph SharePoint endpoints.",
        baseUrl: "https://graph.microsoft.com/v1.0",
        auth: { type: "oauth", tokenKey: "sharepoint", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "sharepoint", officialUrl: "https://learn.microsoft.com/en-us/graph/api/resources/sharepoint" },
      },
    ],
  },
{
    marketplaceKey: "pipedrive",
    displayName: "Pipedrive",
    status: "official-api",
    officialSource: "https://pipedrive.readme.io/docs/core-api-concepts-authentication",
    integrationPath: "Official Pipedrive REST API; no official first-party MCP found in first pass",
    auth: "Pipedrive OAuth 2.0 or API token",
    apis: [
      {
        id: "pipedrive",
        displayName: "Pipedrive",
        description: "Call Pipedrive REST API endpoints.",
        baseUrl: "https://api.pipedrive.com",
        auth: { type: "api_key", tokenKey: "pipedrive", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "pipedrive",
          officialUrl: "https://pipedrive.readme.io/docs/core-api-concepts-authentication",
        },
      },
    ],
  },
{
    marketplaceKey: "pylon",
    displayName: "Pylon",
    status: "official-api",
    officialSource: "https://docs.usepylon.com/pylon-docs/developer/api/authentication",
    integrationPath: "Official Pylon API; no official first-party MCP found in first pass",
    auth: "Pylon bearer API token",
    apis: [
      {
        id: "pylon",
        displayName: "Pylon",
        description: "Call Pylon API endpoints.",
        baseUrl: "https://api.usepylon.com",
        auth: { type: "api_key", tokenKey: "pylon", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "pylon",
          officialUrl: "https://docs.usepylon.com/pylon-docs/developer/api/authentication",
        },
      },
    ],
  },
{
    marketplaceKey: "quartr",
    displayName: "Quartr",
    status: "official-api",
    officialSource: "https://docs.quartr.com/v2/guide/authentication",
    integrationPath: "Official Quartr API; no official first-party MCP found in first pass",
    auth: "Quartr API key in X-API-KEY header",
    apis: [
      {
        id: "quartr",
        displayName: "Quartr",
        description: "Call Quartr API endpoints.",
        baseUrl: "https://api.quartr.com",
        auth: { type: "api_key", tokenKey: "quartr", headerName: "X-API-KEY", scheme: "raw" },
        source: {
          marketplaceKey: "quartr",
          officialUrl: "https://docs.quartr.com/v2/guide/authentication",
        },
      },
    ],
  },
{
    marketplaceKey: "quicknode",
    displayName: "Quicknode",
    status: "official-cli",
    officialSource: "https://www.quicknode.com/docs/build-with-ai/quicknode-mcp",
    integrationPath: "Official remote MCP server",
    auth: "Quicknode OAuth 2.1 or API key bearer token",
    commands: [
      {
        id: "quicknode",
        displayName: "Quicknode",
        description: "Manage Quicknode endpoints, security, usage, billing, chains, and endpoint resources.",
        transport: "streamable_http",
        url: "https://mcp.quicknode.com/mcp",
        auth: { type: "oauth", tokenKey: "quicknode" },
        source: {
          marketplaceKey: "quicknode",
          officialUrl: "https://www.quicknode.com/docs/build-with-ai/quicknode-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "razorpay",
    displayName: "Razorpay",
    status: "official-cli",
    officialSource: "https://razorpay.com/docs/mcp-server/remote/",
    integrationPath: "Official remote MCP server",
    auth: "Razorpay API key/secret as Basic authorization or OAuth",
    commands: [
      {
        id: "razorpay",
        displayName: "Razorpay",
        description: "Execute Razorpay payment, order, refund, QR code, settlement, payout, and payment-link operations.",
        transport: "streamable_http",
        url: "https://mcp.razorpay.com/mcp",
        auth: {
          type: "api_key",
          tokenKey: "razorpay",
          headerName: "Authorization",
        },
        source: {
          marketplaceKey: "razorpay",
          officialUrl: "https://razorpay.com/docs/mcp-server/remote/",
        },
      },
    ],
  },
{
    marketplaceKey: "sendgrid",
    displayName: "SendGrid",
    status: "official-api",
    officialSource:
      "https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication",
    integrationPath: "Official Twilio SendGrid Web API v3; no official first-party MCP found in first pass",
    auth: "SendGrid API key bearer token",
    apis: [
      {
        id: "sendgrid",
        displayName: "SendGrid",
        description: "Call Twilio SendGrid v3 API endpoints.",
        baseUrl: "https://api.sendgrid.com",
        auth: { type: "api_key", tokenKey: "sendgrid", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "sendgrid",
          officialUrl:
            "https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication",
        },
      },
    ],
  },
{
    marketplaceKey: "read-ai",
    displayName: "Read AI",
    status: "official-cli",
    officialSource: "https://support.read.ai/hc/en-us/articles/49381158409491",
    integrationPath: "Official remote MCP server",
    auth: "Read AI OAuth 2.1",
    commands: [
      {
        id: "read-ai",
        displayName: "Read AI",
        description: "Access Read AI meeting transcripts, summaries, action items, and related meeting data.",
        transport: "streamable_http",
        url: "https://api.read.ai/mcp",
        auth: { type: "oauth", tokenKey: "read-ai" },
        source: {
          marketplaceKey: "read-ai",
          officialUrl: "https://support.read.ai/hc/en-us/articles/49381158409491",
        },
      },
    ],
  },
{
    marketplaceKey: "readwise",
    displayName: "Readwise",
    status: "official-cli",
    officialSource: "https://docs.readwise.io/tools/mcp",
    integrationPath: "Official remote MCP server",
    auth: "Readwise OAuth",
    commands: [
      {
        id: "readwise",
        displayName: "Readwise",
        description: "Search and manage Readwise highlights and Reader documents.",
        transport: "streamable_http",
        url: "https://mcp2.readwise.io/mcp",
        auth: { type: "oauth", tokenKey: "readwise" },
        source: {
          marketplaceKey: "readwise",
          officialUrl: "https://docs.readwise.io/tools/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "responsive",
    displayName: "Responsive",
    status: "official-cli",
    officialSource:
      "https://help.responsive.io/en-US/responsive/article/duV3ckq5-connecting-responsive-mcp-server-to-generative-ai-tools",
    integrationPath: "Official remote MCP server",
    auth: "Responsive login/OAuth; API tokens for REST API",
    commands: [
      {
        id: "responsive",
        displayName: "Responsive",
        description: "Retrieve approved Responsive RFP content and knowledge-base answers for proposal workflows.",
        transport: "streamable_http",
        url: "https://app.rfpio.com/oa/v1/mcp",
        auth: { type: "oauth", tokenKey: "responsive" },
        source: {
          marketplaceKey: "responsive",
          officialUrl:
            "https://help.responsive.io/en-US/responsive/article/duV3ckq5-connecting-responsive-mcp-server-to-generative-ai-tools",
        },
      },
    ],
  },
{
    marketplaceKey: "semrush",
    displayName: "Semrush",
    status: "official-cli",
    officialSource: "https://developer.semrush.com/api/introduction/semrush-mcp/",
    integrationPath: "Official remote MCP server",
    auth: "Semrush OAuth 2.1 or API key",
    commands: [
      {
        id: "semrush",
        displayName: "Semrush",
        description: "Query Semrush SEO, traffic, market, backlink, keyword, and project data.",
        transport: "streamable_http",
        url: "https://mcp.semrush.com/v1/mcp",
        auth: { type: "oauth", tokenKey: "semrush" },
        source: {
          marketplaceKey: "semrush",
          officialUrl: "https://developer.semrush.com/api/introduction/semrush-mcp/",
        },
      },
    ],
  },
{
    marketplaceKey: "slack",
    displayName: "Slack",
    status: "official-cli",
    officialSource: "https://docs.slack.dev/ai/slack-mcp-server/",
    integrationPath: "Official remote MCP server",
    auth: "Slack confidential OAuth app credentials",
    commands: [
      {
        id: "slack",
        displayName: "Slack",
        description: "Search Slack workspace content, read and send messages, manage canvases, and inspect users.",
        transport: "streamable_http",
        url: "https://mcp.slack.com/mcp",
        auth: { type: "oauth", tokenKey: "slack" },
        source: {
          marketplaceKey: "slack",
          officialUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
        },
      },
    ],
  },
{
    marketplaceKey: "signnow",
    displayName: "SignNow",
    status: "official-api",
    officialSource: "https://helpcenter.signnow.com/en/articles/13251035-get-started-with-the-signnow-api",
    integrationPath: "Official SignNow REST API; no official first-party MCP found in first pass",
    auth: "SignNow OAuth 2.0 access token",
    apis: [
      {
        id: "signnow",
        displayName: "SignNow",
        description: "Call SignNow REST API endpoints.",
        baseUrl: "https://api.signnow.com",
        auth: { type: "oauth", tokenKey: "signnow", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "signnow",
          officialUrl: "https://helpcenter.signnow.com/en/articles/13251035-get-started-with-the-signnow-api",
        },
      },
    ],
  },
{
    marketplaceKey: "skywatch",
    displayName: "SkyWatch",
    status: "official-cli",
    officialSource: "https://docs.skywatch.com/docs/",
    integrationPath: "Official remote MCP server plus REST API",
    auth: "SkyWatch API key in x-api-key header",
    commands: [
      {
        id: "skywatch",
        displayName: "SkyWatch",
        description: "Search satellite imagery and geospatial data through SkyWatch's EarthCache platform.",
        transport: "streamable_http",
        url: "https://api.skywatch.co/mcp",
        auth: {
          type: "api_key",
          tokenKey: "skywatch",
          headerName: "x-api-key",
        },
        source: {
          marketplaceKey: "skywatch",
          officialUrl: "https://docs.skywatch.com/docs/",
        },
      },
    ],
  },
{
    marketplaceKey: "statsig",
    displayName: "Statsig",
    status: "official-cli",
    officialSource: "https://www.statsig.com/blog/statsig-mcp-server-guide",
    integrationPath: "Official remote MCP server",
    auth: "Statsig OAuth",
    commands: [
      {
        id: "statsig",
        displayName: "Statsig",
        description: "Inspect and manage Statsig feature gates, experiments, analysis, and rollout workflows.",
        transport: "streamable_http",
        url: "https://api.statsig.com/v1/mcp",
        auth: { type: "oauth", tokenKey: "statsig" },
        source: {
          marketplaceKey: "statsig",
          officialUrl: "https://www.statsig.com/blog/statsig-mcp-server-guide",
        },
      },
    ],
  },
{
    marketplaceKey: "stripe",
    displayName: "Stripe",
    status: "official-cli",
    officialSource: "https://docs.stripe.com/mcp",
    integrationPath: "Official remote MCP server",
    auth: "OAuth or Stripe API key bearer token",
    commands: [
      {
        id: "stripe",
        displayName: "Stripe",
        description: "Interact with Stripe API resources and search Stripe documentation/support content.",
        transport: "streamable_http",
        url: "https://mcp.stripe.com",
        auth: { type: "oauth", tokenKey: "stripe" },
        source: {
          marketplaceKey: "stripe",
          officialUrl: "https://docs.stripe.com/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "streak",
    displayName: "Streak",
    status: "official-api",
    officialSource: "https://streak.readme.io/docs/authentication",
    integrationPath: "Official Streak API; no official first-party MCP found in first pass",
    auth: "Streak API key via HTTP Basic auth",
    apis: [
      {
        id: "streak",
        displayName: "Streak",
        description: "Call Streak API endpoints.",
        baseUrl: "https://www.streak.com/api",
        auth: { type: "api_key", tokenKey: "streak", headerName: "Authorization", scheme: "basic" },
        source: {
          marketplaceKey: "streak",
          officialUrl: "https://streak.readme.io/docs/authentication",
        },
      },
    ],
  },
{
    marketplaceKey: "teams",
    displayName: "Teams",
    status: "official-api",
    officialSource: "https://learn.microsoft.com/en-us/graph/teams-concept-overview",
    integrationPath: "Official Microsoft Graph Teams API; no standalone official Teams MCP found in first pass",
    auth: "Microsoft OAuth",
    apis: [
      {
        id: "teams",
        displayName: "Teams",
        description: "Call Microsoft Graph Teams endpoints.",
        baseUrl: "https://graph.microsoft.com/v1.0",
        auth: { type: "oauth", tokenKey: "teams", headerName: "Authorization", scheme: "bearer" },
        source: { marketplaceKey: "teams", officialUrl: "https://learn.microsoft.com/en-us/graph/teams-concept-overview" },
      },
    ],
  },
{
    marketplaceKey: "teamwork-com",
    displayName: "Teamwork.com",
    status: "official-cli",
    officialSource: "https://github.com/Teamwork/mcp",
    integrationPath: "Official Teamwork.com MCP server",
    auth: "Teamwork bearer token or OAuth2",
    commands: [
      {
        id: "teamwork-com",
        displayName: "Teamwork.com",
        description: "Work with Teamwork.com projects, tasks, tags, timers, and project-management data.",
        transport: "streamable_http",
        url: "https://mcp.ai.teamwork.com",
        auth: { type: "oauth", tokenKey: "teamwork-com" },
        source: {
          marketplaceKey: "teamwork-com",
          officialUrl: "https://github.com/Teamwork/mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "vercel",
    displayName: "Vercel",
    status: "official-cli",
    officialSource: "https://vercel.com/docs/mcp/vercel-mcp",
    integrationPath: "Official remote MCP server",
    auth: "Vercel OAuth",
    commands: [
      {
        id: "vercel",
        displayName: "Vercel",
        description: "Search Vercel docs, manage projects and deployments, and analyze deployment logs.",
        transport: "streamable_http",
        url: "https://mcp.vercel.com",
        auth: { type: "oauth", tokenKey: "vercel" },
        source: {
          marketplaceKey: "vercel",
          officialUrl: "https://vercel.com/docs/mcp/vercel-mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "vantage",
    displayName: "Vantage",
    status: "official-cli",
    officialSource: "https://docs.vantage.sh/vantage_mcp",
    integrationPath: "Official remote MCP server plus self-hosted option",
    auth: "Vantage OAuth",
    commands: [
      {
        id: "vantage",
        displayName: "Vantage",
        description: "Analyze cloud cost spend, providers, tags, reports, and related Vantage data.",
        transport: "streamable_http",
        url: "https://mcp.vantage.sh/mcp",
        auth: { type: "oauth", tokenKey: "vantage" },
        source: {
          marketplaceKey: "vantage",
          officialUrl: "https://docs.vantage.sh/vantage_mcp",
        },
      },
    ],
  },
{
    marketplaceKey: "windsor-ai",
    displayName: "Windsor.ai",
    status: "official-cli",
    officialSource: "https://learn.microsoft.com/en-us/connectors/windsorai/",
    integrationPath: "Official Windsor.ai MCP server connector",
    auth: "Windsor.ai OAuth 2.0",
    commands: [
      {
        id: "windsor-ai",
        displayName: "Windsor.ai",
        description: "Discover and query connected Windsor.ai marketing, analytics, CRM, and ecommerce data sources.",
        transport: "streamable_http",
        url: "https://mcp.windsor.ai/",
        auth: { type: "oauth", tokenKey: "windsor-ai" },
        source: {
          marketplaceKey: "windsor-ai",
          officialUrl: "https://learn.microsoft.com/en-us/connectors/windsorai/",
        },
      },
    ],
  },
{
    marketplaceKey: "yepcode",
    displayName: "YepCode",
    status: "official-cli",
    officialSource: "https://yepcode.io/docs/mcp-server/",
    integrationPath: "Official hosted MCP server plus self-hosted option",
    auth: "YepCode OAuth or API token",
    commands: [
      {
        id: "yepcode",
        displayName: "YepCode",
        description: "Run YepCode scripts, expose tagged processes as tools, and manage YepCode storage/API resources.",
        transport: "streamable_http",
        url: "https://cloud.yepcode.io/mcp",
        auth: { type: "oauth", tokenKey: "yepcode" },
        source: {
          marketplaceKey: "yepcode",
          officialUrl: "https://yepcode.io/docs/mcp-server/",
        },
      },
    ],
  },
{
    marketplaceKey: "build-ios-apps",
    displayName: "Build iOS Apps",
    status: "official-cli",
    officialSource: "https://www.xcodebuildmcp.com/",
    integrationPath: "Open-source local MCP server for Xcode automation",
    auth: "Local Xcode/macOS permissions; no service OAuth",
    notes:
      "Use the provider-neutral XcodeBuildMCP package directly instead of any Codex-branded marketplace wrapper.",
    commands: [
      {
        id: "xcodebuildmcp",
        displayName: "XcodeBuildMCP",
        description: "Build, test, run, debug, and automate iOS/macOS projects with Xcode tooling.",
        transport: "stdio",
        command: "npx",
        args: ["-y", "xcodebuildmcp@latest", "mcp"],
        auth: { type: "none" },
        source: {
          marketplaceKey: "build-ios-apps",
          officialUrl: "https://www.xcodebuildmcp.com/",
        },
      },
    ],
  },
{
    marketplaceKey: "happenstance",
    displayName: "Happenstance",
    status: "official-api",
    officialSource: "https://developer.happenstance.ai/",
    integrationPath: "Official REST API and MCP documentation",
    auth: "Happenstance bearer token",
    apis: [
      {
        id: "happenstance",
        displayName: "Happenstance",
        description: "Call Happenstance API endpoints.",
        baseUrl: "https://api.happenstance.ai",
        auth: { type: "api_key", tokenKey: "happenstance", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "happenstance",
          officialUrl: "https://developer.happenstance.ai/",
        },
      },
    ],
    notes:
      "Developer docs expose REST APIs, CLI, OpenAPI, and MCP setup; no universal remote MCP URL is embedded here until verified from the MCP page.",
  },
{
    marketplaceKey: "marcopolo",
    displayName: "MarcoPolo",
    status: "official-cli",
    officialSource: "https://docs.marcopolo.dev/",
    integrationPath: "Official remote MCP server",
    auth: "OAuth with dynamic discovery",
    commands: [
      {
        id: "marcopolo",
        displayName: "MarcoPolo",
        description: "Connect AI agents to governed data sources and a secure analysis workspace.",
        transport: "streamable_http",
        url: "https://mcp.marcopolo.dev",
        auth: { type: "oauth", tokenKey: "marcopolo" },
        source: {
          marketplaceKey: "marcopolo",
          officialUrl: "https://docs.marcopolo.dev/",
        },
      },
    ],
  },
{
    marketplaceKey: "myregistry-com",
    displayName: "MyRegistry.com",
    status: "official-api",
    officialSource: "https://developers.myregistry.com/reference/new-endpoint",
    integrationPath: "Official Registry API",
    auth: "MyRegistry developer credentials",
    apis: [
      {
        id: "myregistry-com",
        displayName: "MyRegistry.com",
        description: "Call MyRegistry Registry API endpoints.",
        baseUrl: "https://api.myregistry.com",
        auth: { type: "api_key", tokenKey: "myregistry-com", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "myregistry-com",
          officialUrl: "https://developers.myregistry.com/reference/new-endpoint",
        },
      },
    ],
    notes:
      "Developer portal exposes Registry API documentation; no first-party MCP endpoint found.",
  },
{
    marketplaceKey: "network-solutions",
    displayName: "Network Solutions",
    status: "official-api",
    officialSource: "https://content.networksolutions.com/netsol/pdf/commerce-space/public-api-documentation.pdf",
    integrationPath: "Official legacy public commerce API documentation",
    auth: "Network Solutions API credentials",
    configFields: [
      { key: "NETWORK_SOLUTIONS_API_URL", label: "Network Solutions API URL", placeholder: "https://..." },
      { key: "network-solutions", label: "Network Solutions API key", secret: true },
    ],
    apis: [
      {
        id: "network-solutions",
        displayName: "Network Solutions",
        description: "Call the configured Network Solutions ecommerce API endpoint.",
        baseUrl: "${NETWORK_SOLUTIONS_API_URL}",
        auth: { type: "api_key", tokenKey: "network-solutions", headerName: "Authorization", scheme: "raw" },
        source: {
          marketplaceKey: "network-solutions",
          officialUrl: "https://content.networksolutions.com/netsol/pdf/commerce-space/public-api-documentation.pdf",
        },
      },
    ],
    notes:
      "The public API documentation found is legacy/ecommerce-specific; DNS/domain management MCP or modern API was not found.",
  },
{
    marketplaceKey: "particl-market-research",
    displayName: "Particl Market Research",
    status: "official-cli",
    officialSource: "https://www.particl.com/docs/mcp/data-privacy",
    integrationPath: "Official Particl MCP connector",
    auth: "Particl account",
    configFields: [
      { key: "PARTICL_MCP_URL", label: "Particl MCP URL", placeholder: "https://..." },
      { key: "PARTICL_API_KEY", label: "Particl API key", secret: true },
    ],
    notes:
      "Particl publishes MCP data-privacy documentation for its market research connector; endpoint is resolved by provider/client setup.",
    commands: [
      {
        id: "particl-market-research",
        displayName: "Particl Market Research",
        description: "Use Particl's hosted MCP connector for market and competitor research.",
        transport: "streamable_http",
        url: "${PARTICL_MCP_URL}",
        headers: {
          Authorization: "Bearer ${PARTICL_API_KEY}",
        },
        auth: { type: "none" },
        source: {
          marketplaceKey: "particl-market-research",
          officialUrl: "https://www.particl.com/docs/mcp/quickstart",
        },
      },
    ],
  },
{
    marketplaceKey: "waldo",
    displayName: "Waldo",
    status: "official-api",
    officialSource: "https://docs.waldo.ai/",
    integrationPath: "Official Waldo AI API",
    auth: "Waldo API key",
    apis: [
      {
        id: "waldo",
        displayName: "Waldo",
        description: "Call Waldo AI API endpoints.",
        baseUrl: "https://api.waldo.ai",
        auth: { type: "api_key", tokenKey: "waldo", headerName: "Authorization", scheme: "bearer" },
        source: {
          marketplaceKey: "waldo",
          officialUrl: "https://docs.waldo.ai/",
        },
      },
    ],
    notes:
      "The local marketplace entry points to Waldo brand research; public API docs surfaced for Waldo AI fraud/compliance, so Stella should confirm tenant/product match before enabling execution.",
  }
];

export const getOfficialConnector = (marketplaceKey: string) =>
  OFFICIAL_CONNECTOR_DEFINITIONS.find(
    (entry) => entry.marketplaceKey === marketplaceKey,
  );
