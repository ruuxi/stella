import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
const SHA256 = /^[0-9a-f]{64}$/;

export type RemotePrompt = { id: string; sha256: string; content: string };
export type RemotePromptManifest = {
  schemaVersion: 1;
  revision: string;
  prompts: RemotePrompt[];
};

type CachedPromptManifest = {
  endpoint: string;
  etag?: string;
  manifest: RemotePromptManifest;
};

export type PromptManifestResolution = {
  source: "fresh-remote" | "cached-remote" | "bundled-bootstrap";
  manifest: RemotePromptManifest | null;
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export const parseRemotePromptManifest = (
  value: unknown,
): RemotePromptManifest | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RemotePromptManifest>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.revision !== "string" ||
    !candidate.revision.trim() ||
    !Array.isArray(candidate.prompts)
  ) {
    return null;
  }
  const ids = new Set<string>();
  for (const prompt of candidate.prompts) {
    if (
      !prompt ||
      typeof prompt.id !== "string" ||
      !/^(agents|prompts)\/[a-z0-9][a-z0-9_-]*\.md$/.test(prompt.id) ||
      ids.has(prompt.id) ||
      typeof prompt.content !== "string" ||
      typeof prompt.sha256 !== "string" ||
      !SHA256.test(prompt.sha256) ||
      sha256(prompt.content) !== prompt.sha256
    ) {
      return null;
    }
    ids.add(prompt.id);
  }
  return candidate as RemotePromptManifest;
};

const cachePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", PROMPT_CACHE_FILE);

const readCache = async (
  stellaDataDir: string,
  endpoint: string,
): Promise<CachedPromptManifest | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(cachePath(stellaDataDir), "utf-8"),
    ) as Partial<CachedPromptManifest>;
    const manifest = parseRemotePromptManifest(parsed.manifest);
    if (parsed.endpoint !== endpoint || !manifest) return null;
    return {
      endpoint,
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
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
};

export const resolvePromptManifest = async (args: {
  stellaDataDir: string;
  siteUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<PromptManifestResolution> => {
  const siteUrl = args.siteUrl?.trim();
  if (!siteUrl) {
    return { source: "bundled-bootstrap", manifest: null };
  }
  const endpoint = `${normalizeStellaSiteUrl(siteUrl)}${STELLA_PROMPTS_PATH}`;
  const cached = await readCache(args.stellaDataDir, endpoint);
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
    const manifest = parseRemotePromptManifest(await response.json());
    if (!manifest) throw new Error("Invalid prompt manifest");
    await writeCacheAtomic(args.stellaDataDir, {
      endpoint,
      ...(response.headers.get("etag")
        ? { etag: response.headers.get("etag")! }
        : {}),
      manifest,
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

const createRemoteAdapter = (
  sourceKey: string,
  prompts: Map<string, RemotePrompt>,
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
    const temp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(temp, prompt.content, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(temp, target);
  },
  remove: async (dir, id) => {
    await fs.rm(path.join(dir, `${id}.md`), { force: true });
  },
});

export const reconcileRemotePromptManifest = async (
  manifest: RemotePromptManifest,
  stellaDataDir: string,
): Promise<BundledSyncReport[]> => {
  const reports: BundledSyncReport[] = [];
  for (const area of ["agents", "prompts"] as const) {
    const entries = new Map<string, RemotePrompt>();
    for (const prompt of manifest.prompts) {
      const prefix = `${area}/`;
      if (!prompt.id.startsWith(prefix)) continue;
      entries.set(prompt.id.slice(prefix.length, -3), prompt);
    }
    if (entries.size === 0) continue;
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
