import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_ID_SET,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  STELLA_PROMPT_MAX_MANIFEST_BYTES,
  STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES,
  STELLA_PROMPT_REVISION_PATTERN,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "../../contracts/stella-prompts.js";
import {
  STELLA_PROMPTS_PATH,
  stellaPromptEndpointFromSiteUrl,
} from "../../contracts/stella-api.js";
import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  reconcileBundledEntries,
  type BundledEntryAdapter,
  type BundledSyncReport,
} from "./bundled-sync.js";

const PROMPT_CACHE_FILE = "prompt-manifest.json";
const PROMPT_APPLIED_STATE_FILE = "prompt-applied-state.json";
const PROMPT_APPLIED_STATE_DIR = "prompt-applied-state";
const PROMPT_LEGACY_APPLIED_STATE_MAX_BYTES = 256 * 1024;
const PROMPT_APPLIED_STATE_RECORD_MAX_BYTES = 4 * 1024;
const PROMPT_APPLIED_STATE_RECOVERY_RECORDS = 4;
const PROMPT_APPLY_LOCK_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;

export type RemotePrompt = { id: string; sha256: string; content: string };
export type RemotePromptManifest = {
  schemaVersion: typeof STELLA_PROMPT_SCHEMA_VERSION;
  revision: string;
  publishedAt: number;
  prompts: RemotePrompt[];
};

type CachedPromptManifest = {
  endpoint: string;
  etag?: string;
  manifest: RemotePromptManifest;
};

export type AppliedPromptState = {
  endpoint: string;
  publishedAt: number;
  revision: string;
};

type AppliedPromptStateFile = {
  version: 1;
  entries: Record<string, Pick<AppliedPromptState, "publishedAt" | "revision">>;
};

type ReconciledPrompt = RemotePrompt;

export type PromptManifestResolution = {
  source: "fresh-remote" | "cached-remote" | "bundled-bootstrap";
  manifest: RemotePromptManifest | null;
  endpoint?: string;
};

const appliedStateMemory = new Map<string, AppliedPromptState>();
const promptApplyQueueTails = new Map<string, Promise<void>>();

export const resetPromptAppliedStateMemoryForTests = (): void => {
  appliedStateMemory.clear();
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const utf8Bytes = (content: string): number =>
  Buffer.byteLength(content, "utf-8");

const revisionForPrompts = (prompts: readonly RemotePrompt[]): string =>
  sha256(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );

const publicationEtag = (
  manifest: Pick<RemotePromptManifest, "publishedAt" | "revision">,
): string => `"${manifest.publishedAt}-${manifest.revision}"`;

export const parseRemotePromptManifest = (
  value: unknown,
): RemotePromptManifest | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RemotePromptManifest>;
  if (
    candidate.schemaVersion !== STELLA_PROMPT_SCHEMA_VERSION ||
    typeof candidate.revision !== "string" ||
    !STELLA_PROMPT_REVISION_PATTERN.test(candidate.revision) ||
    typeof candidate.publishedAt !== "number" ||
    !Number.isSafeInteger(candidate.publishedAt) ||
    candidate.publishedAt < 0 ||
    !Array.isArray(candidate.prompts) ||
    candidate.prompts.length !== STELLA_PROMPT_COUNT
  ) {
    return null;
  }
  const ids = new Set<string>();
  let totalContentBytes = 0;
  for (const prompt of candidate.prompts) {
    if (
      !prompt ||
      typeof prompt.id !== "string" ||
      !STELLA_PROMPT_ID_SET.has(prompt.id) ||
      ids.has(prompt.id) ||
      typeof prompt.content !== "string" ||
      prompt.content.length === 0 ||
      typeof prompt.sha256 !== "string" ||
      !STELLA_PROMPT_REVISION_PATTERN.test(prompt.sha256) ||
      sha256(prompt.content) !== prompt.sha256
    ) {
      return null;
    }
    const contentBytes = utf8Bytes(prompt.content);
    if (contentBytes > STELLA_PROMPT_MAX_CONTENT_BYTES) return null;
    totalContentBytes += contentBytes;
    if (totalContentBytes > STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES) return null;
    ids.add(prompt.id);
  }
  if (
    ids.size !== STELLA_PROMPT_COUNT ||
    revisionForPrompts(candidate.prompts) !== candidate.revision
  ) {
    return null;
  }
  return candidate as RemotePromptManifest;
};

const cachePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", PROMPT_CACHE_FILE);

const appliedStatePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", PROMPT_APPLIED_STATE_FILE);

const appliedStateDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", PROMPT_APPLIED_STATE_DIR);

const appliedStateEndpointDir = (
  stellaDataDir: string,
  endpoint: string,
): string => path.join(appliedStateDir(stellaDataDir), sha256(endpoint));

const promptApplyLockDatabasePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", "prompt-apply-lock.sqlite");

const appliedStateKey = (stellaDataDir: string, endpoint: string): string =>
  `${path.resolve(stellaDataDir)}\0${endpoint}`;

const isHttpEndpoint = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

const canonicalPromptEndpoint = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.endsWith(STELLA_PROMPTS_PATH)
    ) {
      return null;
    }
    const sitePath = parsed.pathname.slice(0, -STELLA_PROMPTS_PATH.length);
    return stellaPromptEndpointFromSiteUrl(`${parsed.origin}${sitePath}`);
  } catch {
    return null;
  }
};

const readCache = async (
  stellaDataDir: string,
  expectedEndpoint?: string,
): Promise<CachedPromptManifest | null> => {
  try {
    const raw = await fs.readFile(cachePath(stellaDataDir), "utf-8");
    if (utf8Bytes(raw) > STELLA_PROMPT_MAX_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<CachedPromptManifest>;
    const manifest = parseRemotePromptManifest(parsed.manifest);
    if (
      typeof parsed.endpoint !== "string" ||
      !isHttpEndpoint(parsed.endpoint) ||
      (expectedEndpoint !== undefined &&
        parsed.endpoint !== expectedEndpoint) ||
      !manifest
    ) {
      return null;
    }
    return {
      endpoint: parsed.endpoint,
      ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
      manifest,
    };
  } catch {
    return null;
  }
};

const isValidAppliedState = (value: unknown): value is AppliedPromptState => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppliedPromptState>;
  return (
    typeof candidate.endpoint === "string" &&
    canonicalPromptEndpoint(candidate.endpoint) === candidate.endpoint &&
    typeof candidate.publishedAt === "number" &&
    Number.isSafeInteger(candidate.publishedAt) &&
    candidate.publishedAt >= 0 &&
    typeof candidate.revision === "string" &&
    STELLA_PROMPT_REVISION_PATTERN.test(candidate.revision)
  );
};

const parseAppliedStateFile = (
  value: unknown,
): Map<string, AppliedPromptState> | null => {
  if (isValidAppliedState(value)) {
    return new Map([[value.endpoint, value]]);
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AppliedPromptStateFile>;
  if (
    candidate.version !== 1 ||
    !candidate.entries ||
    typeof candidate.entries !== "object" ||
    Array.isArray(candidate.entries)
  ) {
    return null;
  }
  const rawEntries = Object.entries(candidate.entries);
  const entries = new Map<string, AppliedPromptState>();
  for (const [endpoint, raw] of rawEntries) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "publishedAt,revision"
    ) {
      return null;
    }
    const state = { ...(raw as object), endpoint };
    if (!isValidAppliedState(state)) return null;
    entries.set(endpoint, state);
  }
  return entries;
};

const readLegacyAppliedStateFile = async (
  stellaDataDir: string,
): Promise<Map<string, AppliedPromptState>> => {
  try {
    const raw = await fs.readFile(appliedStatePath(stellaDataDir), "utf-8");
    if (utf8Bytes(raw) > PROMPT_LEGACY_APPLIED_STATE_MAX_BYTES) {
      return new Map();
    }
    return parseAppliedStateFile(JSON.parse(raw)) ?? new Map();
  } catch {
    return new Map();
  }
};

const readAppliedStateRecord = async (
  filePath: string,
): Promise<AppliedPromptState | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    if (utf8Bytes(raw) > PROMPT_APPLIED_STATE_RECORD_MAX_BYTES) return null;
    const parsed = JSON.parse(raw);
    return isValidAppliedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

type AppliedStateRecord = { filePath: string; state: AppliedPromptState };

const listAppliedStateRecords = async (
  stellaDataDir: string,
  endpoint: string,
): Promise<AppliedStateRecord[]> => {
  const endpointDir = appliedStateEndpointDir(stellaDataDir, endpoint);
  const files = await fs.readdir(endpointDir).catch(() => []);
  const records: AppliedStateRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(endpointDir, file);
    const state = await readAppliedStateRecord(filePath);
    if (state?.endpoint === endpoint) records.push({ filePath, state });
  }
  return records;
};

const newerAppliedState = (
  left: AppliedPromptState | null,
  right: AppliedPromptState | null,
): AppliedPromptState | null => {
  if (!left) return right;
  if (!right) return left;
  if (left.publishedAt !== right.publishedAt) {
    return left.publishedAt > right.publishedAt ? left : right;
  }
  return left.revision.localeCompare(right.revision) >= 0 ? left : right;
};

const readAppliedStateRecords = async (
  stellaDataDir: string,
  expectedEndpoint?: string,
): Promise<AppliedPromptState | null> => {
  const endpointDirs = expectedEndpoint
    ? [appliedStateEndpointDir(stellaDataDir, expectedEndpoint)]
    : await fs
        .readdir(appliedStateDir(stellaDataDir), { withFileTypes: true })
        .then((entries) =>
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) =>
              path.join(appliedStateDir(stellaDataDir), entry.name),
            ),
        )
        .catch(() => []);
  let latest: AppliedPromptState | null = null;
  for (const endpointDir of endpointDirs) {
    const files = await fs.readdir(endpointDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const state = await readAppliedStateRecord(path.join(endpointDir, file));
      if (state && (!expectedEndpoint || state.endpoint === expectedEndpoint)) {
        latest = newerAppliedState(latest, state);
      }
    }
  }
  return latest;
};

const syncDirectory = async (dirPath: string): Promise<void> => {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const ensureDurableAppliedStateDirs = async (
  stellaDataDir: string,
  endpoint: string,
): Promise<string> => {
  const cacheDir = path.join(stellaDataDir, "cache");
  const stateDir = appliedStateDir(stellaDataDir);
  const endpointDir = appliedStateEndpointDir(stellaDataDir, endpoint);
  await ensurePrivateDir(stellaDataDir);
  await ensurePrivateDir(cacheDir);
  await syncDirectory(stellaDataDir);
  await ensurePrivateDir(stateDir);
  await syncDirectory(cacheDir);
  await ensurePrivateDir(endpointDir);
  await syncDirectory(stateDir);
  return endpointDir;
};

const readDurableAppliedState = async (
  stellaDataDir: string,
  expectedEndpoint?: string,
): Promise<AppliedPromptState | null> => {
  const legacyEntries = await readLegacyAppliedStateFile(stellaDataDir);
  const legacy = expectedEndpoint
    ? (legacyEntries.get(expectedEndpoint) ?? null)
    : ([...legacyEntries.values()].reduce(newerAppliedState, null) ?? null);
  const records = await readAppliedStateRecords(
    stellaDataDir,
    expectedEndpoint,
  );
  return newerAppliedState(legacy, records);
};

const readAppliedState = async (
  stellaDataDir: string,
  expectedEndpoint?: string,
): Promise<AppliedPromptState | null> => {
  const disk = await readDurableAppliedState(stellaDataDir, expectedEndpoint);
  const endpoint = expectedEndpoint ?? disk?.endpoint;
  const memory = endpoint
    ? (appliedStateMemory.get(appliedStateKey(stellaDataDir, endpoint)) ?? null)
    : null;
  return newerAppliedState(disk, memory);
};

const writeAppliedStateAtomic = async (
  stellaDataDir: string,
  state: AppliedPromptState,
): Promise<void> => {
  const endpointDir = await ensureDurableAppliedStateDirs(
    stellaDataDir,
    state.endpoint,
  );
  const filePath = path.join(
    endpointDir,
    `${state.publishedAt}-${state.revision}.json`,
  );
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (utf8Bytes(content) > PROMPT_APPLIED_STATE_RECORD_MAX_BYTES) {
    throw new Error("Prompt applied-state record exceeds the size limit");
  }
  const existing = await readAppliedStateRecord(filePath);
  if (existing) {
    if (
      existing.endpoint !== state.endpoint ||
      existing.publishedAt !== state.publishedAt ||
      existing.revision !== state.revision
    ) {
      throw new Error("Prompt applied-state record collision");
    }
    const fileHandle = await fs.open(filePath, "r");
    try {
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    await syncDirectory(endpointDir);
    return;
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let tempHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    tempHandle = await fs.open(tempPath, "wx", 0o600);
    await tempHandle.writeFile(content, "utf-8");
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
    await fs.rename(tempPath, filePath);
    await syncDirectory(endpointDir);
  } catch (error) {
    await tempHandle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

export const compactAppliedStateRecords = async (
  stellaDataDir: string,
  endpoint: string,
  options: { onDurableDelete?: (filePath: string) => Promise<void> } = {},
): Promise<void> => {
  const records = await listAppliedStateRecords(stellaDataDir, endpoint);
  records.sort((left, right) => {
    if (left.state.publishedAt !== right.state.publishedAt) {
      return right.state.publishedAt - left.state.publishedAt;
    }
    return right.state.revision.localeCompare(left.state.revision);
  });
  const obsolete = records.slice(PROMPT_APPLIED_STATE_RECOVERY_RECORDS);
  for (const record of obsolete) {
    await fs.rm(record.filePath);
    await syncDirectory(appliedStateEndpointDir(stellaDataDir, endpoint));
    await options.onDurableDelete?.(record.filePath);
  }
};

const acquirePromptApplyDatabaseLock = async (
  stellaDataDir: string,
  endpoint: string,
): Promise<DatabaseSync> => {
  await ensureDurableAppliedStateDirs(stellaDataDir, endpoint);
  const database = new DatabaseSync(promptApplyLockDatabasePath(stellaDataDir));
  try {
    database.exec(`PRAGMA busy_timeout = ${PROMPT_APPLY_LOCK_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const releasePromptApplyDatabaseLock = (database: DatabaseSync): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // A killed or compromised connection already released its kernel lock.
  } finally {
    database.close();
  }
};

const withPromptApplyLock = async <T>(
  stellaDataDir: string,
  endpoint: string,
  operation: () => Promise<T>,
): Promise<T> => {
  // SQLite serializes every writer to this data directory, so the in-process
  // queue must use the same scope. Otherwise a second synchronous BEGIN could
  // block the event loop while the first holder awaits reconciliation.
  const key = path.resolve(stellaDataDir);
  const previous = promptApplyQueueTails.get(key) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  promptApplyQueueTails.set(key, turn);
  await previous;
  let database: DatabaseSync | null = null;
  try {
    database = await acquirePromptApplyDatabaseLock(stellaDataDir, endpoint);
    return await operation();
  } finally {
    if (database) releasePromptApplyDatabaseLock(database);
    releaseTurn();
    if (promptApplyQueueTails.get(key) === turn) {
      promptApplyQueueTails.delete(key);
    }
  }
};

export class StalePromptManifestError extends Error {
  constructor(
    readonly candidate: AppliedPromptState,
    readonly winner: AppliedPromptState,
  ) {
    super(
      `Prompt publication ${candidate.publishedAt}/${candidate.revision} is stale; durable maximum is ${winner.publishedAt}/${winner.revision}`,
    );
    this.name = "StalePromptManifestError";
  }
}

const recordAppliedPromptManifestLocked = async (args: {
  stellaDataDir: string;
  endpoint: string;
  manifest: RemotePromptManifest;
  writeStateImpl?: typeof writeAppliedStateAtomic;
}): Promise<AppliedPromptState> => {
  const candidate: AppliedPromptState = {
    endpoint: args.endpoint,
    publishedAt: args.manifest.publishedAt,
    revision: args.manifest.revision,
  };
  await (args.writeStateImpl ?? writeAppliedStateAtomic)(
    args.stellaDataDir,
    candidate,
  );
  const winner = await readDurableAppliedState(
    args.stellaDataDir,
    args.endpoint,
  );
  if (!winner) throw new Error("Applied prompt state vanished after write");
  appliedStateMemory.set(
    appliedStateKey(args.stellaDataDir, args.endpoint),
    winner,
  );
  await compactAppliedStateRecords(args.stellaDataDir, args.endpoint);
  if (
    winner.publishedAt !== candidate.publishedAt ||
    winner.revision !== candidate.revision
  ) {
    throw new StalePromptManifestError(candidate, winner);
  }
  return winner;
};

export const recordAppliedPromptManifest = async (args: {
  stellaDataDir: string;
  endpoint: string;
  manifest: RemotePromptManifest;
  writeStateImpl?: typeof writeAppliedStateAtomic;
}): Promise<AppliedPromptState> =>
  withPromptApplyLock(args.stellaDataDir, args.endpoint, () =>
    recordAppliedPromptManifestLocked(args),
  );

export const applyPromptManifestIfCurrent = async <T>(args: {
  stellaDataDir: string;
  endpoint: string;
  manifest: RemotePromptManifest;
  reconcile: () => Promise<T>;
}): Promise<T> =>
  withPromptApplyLock(args.stellaDataDir, args.endpoint, async () => {
    await recordAppliedPromptManifestLocked(args);
    return await args.reconcile();
  });

const writeCacheAtomic = async (
  stellaDataDir: string,
  cache: CachedPromptManifest,
): Promise<void> => {
  const filePath = cachePath(stellaDataDir);
  await ensurePrivateDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

const readBoundedJsonResponse = async (
  response: Response,
): Promise<unknown> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > STELLA_PROMPT_MAX_MANIFEST_BYTES
  ) {
    throw new Error("Prompt manifest is too large");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > STELLA_PROMPT_MAX_MANIFEST_BYTES) {
    throw new Error("Prompt manifest is too large");
  }
  return JSON.parse(new TextDecoder().decode(bytes));
};

const isRollback = (
  fresh: RemotePromptManifest,
  highWater: Pick<RemotePromptManifest, "publishedAt" | "revision">,
): boolean =>
  fresh.publishedAt < highWater.publishedAt ||
  (fresh.publishedAt === highWater.publishedAt &&
    fresh.revision !== highWater.revision);

const highestKnownState = (
  cached: CachedPromptManifest | null,
  applied: AppliedPromptState | null,
): Pick<RemotePromptManifest, "publishedAt" | "revision"> | null => {
  if (!cached) return applied;
  if (!applied) return cached.manifest;
  return cached.manifest.publishedAt > applied.publishedAt
    ? cached.manifest
    : applied;
};

export const resolvePromptManifest = async (args: {
  stellaDataDir: string;
  siteUrl?: string | null;
  fetchImpl?: typeof fetch;
  writeCacheImpl?: typeof writeCacheAtomic;
}): Promise<PromptManifestResolution> => {
  const siteUrl = args.siteUrl?.trim();
  const configuredEndpoint = siteUrl
    ? stellaPromptEndpointFromSiteUrl(siteUrl)
    : undefined;
  const cached = await readCache(args.stellaDataDir, configuredEndpoint);
  const initialApplied = await readAppliedState(
    args.stellaDataDir,
    configuredEndpoint,
  );
  const endpoint =
    configuredEndpoint ?? cached?.endpoint ?? initialApplied?.endpoint;
  if (!endpoint) {
    return { source: "bundled-bootstrap", manifest: null };
  }
  const applied =
    initialApplied?.endpoint === endpoint
      ? initialApplied
      : await readAppliedState(args.stellaDataDir, endpoint);
  const highWater = highestKnownState(cached, applied);
  const safeCached =
    cached && (!applied || !isRollback(cached.manifest, applied))
      ? cached
      : null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (cached) headers["If-None-Match"] = publicationEtag(cached.manifest);
    const response = await (args.fetchImpl ?? fetch)(endpoint, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304 && safeCached) {
      return {
        source: "fresh-remote",
        manifest: safeCached.manifest,
        endpoint,
      };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = parseRemotePromptManifest(
      await readBoundedJsonResponse(response),
    );
    if (!manifest) throw new Error("Invalid prompt manifest");
    if (highWater && isRollback(manifest, highWater)) {
      return safeCached
        ? { source: "cached-remote", manifest: safeCached.manifest, endpoint }
        : { source: "bundled-bootstrap", manifest: null, endpoint };
    }

    const nextCache: CachedPromptManifest = {
      endpoint,
      etag: publicationEtag(manifest),
      manifest,
    };
    await (args.writeCacheImpl ?? writeCacheAtomic)(
      args.stellaDataDir,
      nextCache,
    ).catch((error) => {
      console.warn(
        "[stella-home] Could not persist prompt manifest cache:",
        error,
      );
    });
    return { source: "fresh-remote", manifest, endpoint };
  } catch {
    return safeCached
      ? { source: "cached-remote", manifest: safeCached.manifest, endpoint }
      : { source: "bundled-bootstrap", manifest: null, endpoint };
  } finally {
    clearTimeout(timeout);
  }
};

const readBundledAgentFrontmatter = async (
  bundledAgentsDir: string,
  id: string,
): Promise<string> => {
  const raw = await fs.readFile(
    path.join(bundledAgentsDir, `${id}.md`),
    "utf-8",
  );
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) {
    throw new Error(`Bundled agent ${id} is missing valid frontmatter`);
  }
  return match[0];
};

const resolveReconciledPrompts = async (
  manifest: RemotePromptManifest,
  bundledAgentsDir: string,
): Promise<Map<"agents" | "prompts", Map<string, ReconciledPrompt>>> => {
  const byArea = new Map<"agents" | "prompts", Map<string, ReconciledPrompt>>([
    ["agents", new Map()],
    ["prompts", new Map()],
  ]);
  for (const prompt of manifest.prompts) {
    const area = prompt.id.startsWith("agents/") ? "agents" : "prompts";
    const id = prompt.id.slice(area.length + 1, -3);
    const content =
      area === "agents"
        ? `${await readBundledAgentFrontmatter(bundledAgentsDir, id)}${prompt.content}`
        : prompt.content;
    byArea.get(area)!.set(id, {
      ...prompt,
      content,
      sha256: sha256(content),
    });
  }
  return byArea;
};

const createRemoteAdapter = (
  sourceKey: string,
  prompts: Map<string, ReconciledPrompt>,
): BundledEntryAdapter => ({
  listIds: async (dir) => {
    if (dir === sourceKey) return [...prompts.keys()].sort();
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  },
  hash: async (dir, id) => {
    if (dir === sourceKey) return prompts.get(id)?.sha256 ?? null;
    try {
      return sha256(await fs.readFile(path.join(dir, `${id}.md`), "utf-8"));
    } catch {
      return null;
    }
  },
  copy: async (_src, dest, id) => {
    const prompt = prompts.get(id);
    if (!prompt) return;
    await ensurePrivateDir(dest);
    const target = path.join(dest, `${id}.md`);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temp, prompt.content, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  },
  remove: async (dir, id) => {
    await fs.rm(path.join(dir, `${id}.md`), { force: true });
  },
});

export const reconcileRemotePromptManifest = async (
  manifest: RemotePromptManifest,
  stellaDataDir: string,
  bundledAgentsDir: string,
): Promise<BundledSyncReport[]> => {
  const reports: BundledSyncReport[] = [];
  const byArea = await resolveReconciledPrompts(manifest, bundledAgentsDir);
  for (const area of ["agents", "prompts"] as const) {
    const entries = byArea.get(area)!;
    const sourceKey = `remote:${area}:${manifest.revision}`;
    reports.push(
      await reconcileBundledEntries(
        sourceKey,
        path.join(stellaDataDir, area),
        createRemoteAdapter(sourceKey, entries),
        {
          sourceRevision: manifest.revision,
          removeObsolete: false,
        },
      ),
    );
  }
  return reports;
};
