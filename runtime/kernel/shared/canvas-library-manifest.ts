/**
 * Canvas library manifest — the machine-maintained index behind the
 * `stella-canvas://library` site. The `html` tool upserts an entry every
 * time it writes a page under `~/.stella/outputs/html/`; the desktop's
 * library protocol serves the merged index (manifest + directory backfill
 * for pages that predate the manifest) to the app-owned library shell.
 *
 * The model never edits this file: tool code appends deterministically,
 * so the index cannot drift or lose entries no matter what the page
 * content looks like.
 */

import path from "node:path";
import fs from "node:fs/promises";

export type CanvasLibraryEntry = {
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  runId?: string;
  agentId?: string;
  agentType?: string;
};

export type CanvasLibraryManifest = {
  version: 1;
  entries: CanvasLibraryEntry[];
};

export const CANVAS_LIBRARY_MANIFEST_FILENAME = "manifest.json";

export const canvasHtmlDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "outputs", "html");

export const canvasLibraryManifestPath = (stellaDataDir: string): string =>
  path.join(canvasHtmlDir(stellaDataDir), CANVAS_LIBRARY_MANIFEST_FILENAME);

export const titleFromCanvasSlug = (slug: string): string =>
  slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char: string) => char.toUpperCase());

const isEntry = (value: unknown): value is CanvasLibraryEntry => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CanvasLibraryEntry>;
  return (
    typeof record.slug === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
};

export const readCanvasLibraryManifest = async (
  stellaDataDir: string,
): Promise<CanvasLibraryManifest> => {
  try {
    const raw = await fs.readFile(
      canvasLibraryManifestPath(stellaDataDir),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Partial<CanvasLibraryManifest>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(isEntry)
      : [];
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
};

const writeCanvasLibraryManifest = async (
  stellaDataDir: string,
  manifest: CanvasLibraryManifest,
): Promise<void> => {
  const target = canvasLibraryManifestPath(stellaDataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await fs.rename(tmp, target);
};

// Concurrent html-tool calls (parallel agents) would otherwise interleave
// read-modify-write cycles; chain upserts so each sees the previous write.
let upsertChain: Promise<unknown> = Promise.resolve();

export type CanvasLibraryUpsert = {
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  conversationId?: string;
  runId?: string;
  agentId?: string;
  agentType?: string;
};

export const upsertCanvasLibraryEntry = (
  stellaDataDir: string,
  upsert: CanvasLibraryUpsert,
): Promise<CanvasLibraryEntry> => {
  const run = async (): Promise<CanvasLibraryEntry> => {
    const manifest = await readCanvasLibraryManifest(stellaDataDir);
    const now = Date.now();
    const existing = manifest.entries.find(
      (entry) => entry.slug === upsert.slug,
    );
    const next: CanvasLibraryEntry = {
      slug: upsert.slug,
      title: upsert.title,
      ...(upsert.description ? { description: upsert.description } : {}),
      ...(upsert.tags && upsert.tags.length > 0 ? { tags: upsert.tags } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(upsert.conversationId
        ? { conversationId: upsert.conversationId }
        : {}),
      ...(upsert.runId ? { runId: upsert.runId } : {}),
      ...(upsert.agentId ? { agentId: upsert.agentId } : {}),
      ...(upsert.agentType ? { agentType: upsert.agentType } : {}),
    };
    const entries = existing
      ? manifest.entries.map((entry) =>
          entry.slug === upsert.slug ? next : entry,
        )
      : [...manifest.entries, next];
    await writeCanvasLibraryManifest(stellaDataDir, { version: 1, entries });
    return next;
  };

  const chained = upsertChain.then(run, run);
  upsertChain = chained.catch(() => undefined);
  return chained;
};

/**
 * Merged view served to the library shell: manifest entries for every page
 * that still exists on disk, plus synthesized entries (title from slug,
 * timestamps from mtime) for pages that predate the manifest. Pages whose
 * files were deleted drop out automatically.
 */
export const buildCanvasLibraryIndex = async (
  stellaDataDir: string,
): Promise<CanvasLibraryManifest> => {
  const dir = canvasHtmlDir(stellaDataDir);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".html"));
  } catch {
    return { version: 1, entries: [] };
  }

  const manifest = await readCanvasLibraryManifest(stellaDataDir);
  const bySlug = new Map(manifest.entries.map((entry) => [entry.slug, entry]));
  const entries: CanvasLibraryEntry[] = [];

  for (const name of names) {
    const slug = name.slice(0, -".html".length);
    const known = bySlug.get(slug);
    if (known) {
      entries.push(known);
      continue;
    }
    try {
      const stats = await fs.stat(path.join(dir, name));
      entries.push({
        slug,
        title: titleFromCanvasSlug(slug),
        createdAt: stats.mtimeMs,
        updatedAt: stats.mtimeMs,
      });
    } catch {
      // File raced away between readdir and stat; skip it.
    }
  }

  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return { version: 1, entries };
};
