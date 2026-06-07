// The OAuth provider catalog data lives in `oauth-provider-catalog.json`
// (generated from the public Composio toolkit catalog on 2026-05-17; entries
// whose public pages omitted actions were backfilled from Composio's MCP search
// metadata). Slack, Slackbot, Discord, Discordbot, Microsoft Teams, and
// WhatsApp are intentionally excluded because Stella handles bot-style
// connections through backend-owned services.
//
// PERF: the catalog is ~8MB of JSON and was previously an inlined `const` in
// this module. That made it ~83% of the 14.6MB electron-main bundle, so V8
// re-parsed 11.6MB of JS source on every cold start and esbuild re-parsed it on
// every rebuild. We now keep the data as a sibling .json read lazily from disk
// (Stella runs from its source tree, so STELLA_APP_DIR points at the repo root)
// and JSON.parse it once on first access. JSON.parse of 8MB is far cheaper than
// V8 parsing 11.6MB of JS, and the bundle drops to ~3MB.

import { readFileSync } from "node:fs";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";

export type OAuthCatalogTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  exactSlug?: boolean;
};

export type OAuthCatalogProvider = {
  id: string;
  name: string;
  category: string;
  auth: readonly ["OAUTH2"];
  catalogToolCount: number;
  description: string;
  sourceUrl: string;
  tools: readonly OAuthCatalogTool[];
};

const CATALOG_JSON_BASENAME = "oauth-provider-catalog.json";

let cachedCatalog: readonly OAuthCatalogProvider[] | null = null;

/**
 * Lazily load and memoize the OAuth provider catalog from disk. The first
 * caller pays a single ~8MB JSON.parse; every subsequent call returns the
 * cached array.
 */
export const getOAuthProviderCatalog = (): readonly OAuthCatalogProvider[] => {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  const catalogPath = resolveRuntimeSourceAsset(
    "runtime",
    "kernel",
    "connectors",
    CATALOG_JSON_BASENAME,
  );
  try {
    const raw = readFileSync(catalogPath, "utf-8");
    cachedCatalog = JSON.parse(raw) as OAuthCatalogProvider[];
    return cachedCatalog;
  } catch (error) {
    throw new Error(
      `Failed to load ${CATALOG_JSON_BASENAME} (tried: ${catalogPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
