/**
 * Disk cache for the server-side native-integration catalog (the backend
 * Composio entries that `buildNativeConnectorCatalog` merges over the
 * bundled fallback catalog).
 *
 * The catalog lives behind an authenticated stella.sh endpoint, but two
 * consumers need it without wanting a network round-trip per use:
 *
 *  - the connector keyword index (checked mechanically against every
 *    incoming user message — must be pure local lookup), and
 *  - the `connector_status` tool / CLI as an offline fallback.
 *
 * Whoever fetches the live catalog (CLI `stella-connect`, the
 * `connector_status` tool) writes through here, so the keyword index
 * stays in sync with the catalog without ever fetching on its own.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildNativeConnectorCatalog,
  type NativeConnectorCatalogEntry,
} from "./native-integrations.js";
import { getConnectorStateRoot } from "./state.js";

const CACHE_FILE = "catalog-cache.json";

type CatalogCacheFile = {
  version: 1;
  fetchedAt: number;
  entries: NativeConnectorCatalogEntry[];
};

const cachePath = (stellaDataDir: string) =>
  path.join(getConnectorStateRoot(stellaDataDir), CACHE_FILE);

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

/**
 * Parse one backend catalog record into a `backend-composio` catalog
 * entry. Shared by the CLI, the `connector_status` tool, and the disk
 * cache reader (cached entries round-trip through the same guard so a
 * stale/corrupt cache can never inject malformed entries).
 */
export const toBackendComposioEntry = (
  value: unknown,
): NativeConnectorCatalogEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const connector =
    record.connector && typeof record.connector === "object"
      ? (record.connector as Record<string, unknown>)
      : null;
  if (connector?.type !== "composio") return null;
  const id =
    typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  const toolkit =
    typeof connector.toolkit === "string"
      ? connector.toolkit.trim().toUpperCase()
      : "";
  if (!id || !name || !description || !toolkit) return null;
  return {
    id,
    name,
    category:
      typeof record.category === "string"
        ? record.category.trim()
        : "integrations",
    auth: readStringArray(record.auth) ?? ["OAUTH2"],
    catalogToolCount:
      typeof record.catalogToolCount === "number" ? record.catalogToolCount : 0,
    availability: "ready",
    provider: "backend-composio",
    description,
    ...(typeof record.sourceUrl === "string" && record.sourceUrl.trim()
      ? { sourceUrl: record.sourceUrl.trim() }
      : {}),
    ...(typeof record.iconUrl === "string" && record.iconUrl.trim()
      ? { iconUrl: record.iconUrl.trim() }
      : {}),
    connectable: true,
    backendConnector: {
      type: "composio",
      toolkit,
    },
  };
};

/** Serialized cache entries re-validated through the same parser shape. */
const toCachedEntry = (value: unknown): NativeConnectorCatalogEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.provider !== "backend-composio") return null;
  // Rebuild through the strict parser by reshaping to the backend format.
  return toBackendComposioEntry({
    ...record,
    connector: {
      type: "composio",
      toolkit: (record.backendConnector as { toolkit?: unknown } | undefined)
        ?.toolkit,
    },
  });
};

export const readCachedServerCatalog = async (
  stellaDataDir: string,
): Promise<{
  entries: NativeConnectorCatalogEntry[];
  fetchedAt: number;
} | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(cachePath(stellaDataDir), "utf-8"),
    ) as CatalogCacheFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries
      .map(toCachedEntry)
      .filter((entry): entry is NativeConnectorCatalogEntry => entry !== null);
    if (entries.length === 0) return null;
    return {
      entries,
      fetchedAt:
        typeof parsed.fetchedAt === "number" && Number.isFinite(parsed.fetchedAt)
          ? parsed.fetchedAt
          : 0,
    };
  } catch {
    return null;
  }
};

export const writeCachedServerCatalog = async (
  stellaDataDir: string,
  entries: readonly NativeConnectorCatalogEntry[],
): Promise<void> => {
  const filePath = cachePath(stellaDataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: CatalogCacheFile = {
    version: 1,
    fetchedAt: Date.now(),
    entries: [...entries],
  };
  await fs.writeFile(
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
};

/**
 * Bundled catalog merged with server entries (server wins by id, new
 * server entries appended). Unlike `buildNativeConnectorCatalog(override)`
 * — which *replaces* the catalog with the override — this keeps the
 * locally-owned entries (Google Workspace, recovered OAuth providers)
 * visible alongside the backend Composio set, which is what keyword
 * matching and status lookups want.
 */
export const buildMergedConnectorCatalog = (
  serverEntries?: readonly NativeConnectorCatalogEntry[],
): NativeConnectorCatalogEntry[] => {
  const base = buildNativeConnectorCatalog();
  if (!serverEntries || serverEntries.length === 0) return base;
  const byId = new Map(base.map((entry) => [entry.id, entry]));
  for (const entry of serverEntries) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
};

/**
 * Fetch the live backend catalog. Returns null on any failure (signed
 * out, offline, malformed response) — callers fall back to the disk
 * cache / bundled catalog.
 */
export const fetchServerNativeCatalog = async (options: {
  baseUrl: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NativeConnectorCatalogEntry[] | null> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${options.baseUrl.replace(/\/+$/u, "")}/api/native-integrations/catalog`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.authToken}`,
      },
    },
  ).catch(() => null);
  if (!response?.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    integrations?: unknown[];
  } | null;
  const entries = (payload?.integrations ?? [])
    .map(toBackendComposioEntry)
    .filter((entry): entry is NativeConnectorCatalogEntry => entry !== null);
  return entries.length > 0 ? entries : null;
};
