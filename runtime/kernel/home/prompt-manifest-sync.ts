import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
  normalizeStellaSiteUrl,
} from "../../contracts/stella-api.js";
import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  reconcileBundledEntries,
  type BundledEntryAdapter,
  type BundledSyncReport,
} from "./bundled-sync.js";

const PROMPT_CACHE_FILE = "prompt-manifest.json";
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

type ReconciledPrompt = RemotePrompt;

export type PromptManifestResolution = {
  source: "fresh-remote" | "cached-remote" | "bundled-bootstrap";
  manifest: RemotePromptManifest | null;
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

const isHttpEndpoint = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
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
  cached: RemotePromptManifest,
): boolean =>
  fresh.publishedAt < cached.publishedAt ||
  (fresh.publishedAt === cached.publishedAt &&
    fresh.revision !== cached.revision);

export const resolvePromptManifest = async (args: {
  stellaDataDir: string;
  siteUrl?: string | null;
  fetchImpl?: typeof fetch;
  writeCacheImpl?: typeof writeCacheAtomic;
}): Promise<PromptManifestResolution> => {
  const siteUrl = args.siteUrl?.trim();
  const configuredEndpoint = siteUrl
    ? `${normalizeStellaSiteUrl(siteUrl)}${STELLA_PROMPTS_PATH}`
    : undefined;
  const cached = await readCache(args.stellaDataDir, configuredEndpoint);
  const endpoint = configuredEndpoint ?? cached?.endpoint;
  if (!endpoint) {
    return { source: "bundled-bootstrap", manifest: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await (args.fetchImpl ?? fetch)(endpoint, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304 && cached) {
      return { source: "fresh-remote", manifest: cached.manifest };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = parseRemotePromptManifest(
      await readBoundedJsonResponse(response),
    );
    if (!manifest) throw new Error("Invalid prompt manifest");
    if (cached && isRollback(manifest, cached.manifest)) {
      return { source: "cached-remote", manifest: cached.manifest };
    }

    const nextCache: CachedPromptManifest = {
      endpoint,
      ...(response.headers.get("etag")
        ? { etag: response.headers.get("etag")! }
        : {}),
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
    return { source: "fresh-remote", manifest };
  } catch {
    return cached
      ? { source: "cached-remote", manifest: cached.manifest }
      : { source: "bundled-bootstrap", manifest: null };
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
