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
// (Stella runs from its source tree, so STELLA_ROOT points at the repo root)
// and JSON.parse it once on first access. JSON.parse of 8MB is far cheaper than
// V8 parsing 11.6MB of JS, and the bundle drops to ~3MB.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const CATALOG_REPO_RELATIVE = [
  "runtime",
  "kernel",
  "connectors",
  CATALOG_JSON_BASENAME,
] as const;

const candidateCatalogPaths = (): string[] => {
  const candidates: string[] = [];

  // Fast path: STELLA_ROOT (repo root) is set in the Electron main process
  // (and inherited by most spawned children), so the catalog resolves directly.
  const stellaRoot = process.env.STELLA_ROOT?.trim();
  if (stellaRoot) {
    candidates.push(path.join(stellaRoot, ...CATALOG_REPO_RELATIVE));
  }

  // Env-independent fallbacks anchored to this module's location. Stella runs
  // from its source tree (it is not packaged), so the JSON always exists under
  // <repoRoot>/runtime/kernel/connectors/. Resolve the repo root by walking up
  // from this module — works whether we're the source file (vitest), the
  // electron-main bundle (desktop/dist-electron/...), or a bundled sidecar CLI
  // (stella-connect), none of which can assume STELLA_ROOT is set in their env.
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    // Sibling: source/vitest runs this module straight from the connectors dir.
    candidates.push(path.join(dir, CATALOG_JSON_BASENAME));
    for (let i = 0; i < 12; i += 1) {
      candidates.push(path.join(dir, ...CATALOG_REPO_RELATIVE));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable in this runtime; rely on STELLA_ROOT above.
  }

  return candidates;
};

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
  let lastError: unknown;
  for (const candidate of candidateCatalogPaths()) {
    try {
      const raw = readFileSync(candidate, "utf-8");
      cachedCatalog = JSON.parse(raw) as OAuthCatalogProvider[];
      return cachedCatalog;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Failed to load ${CATALOG_JSON_BASENAME} (tried: ${candidateCatalogPaths().join(
      ", ",
    )}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};
