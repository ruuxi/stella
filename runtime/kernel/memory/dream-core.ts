/**
 * Shared core for the Dream protocol IO surface.
 *
 * The Dream scheduler and local Dream tool dispatch both use these helpers so
 * behavior stays in one place.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ThreadSummariesStore } from "./thread-summaries-store.js";
import { resolveStellaStatePath } from "../home/stella-home.js";

export const DREAM_WATERMARK_FILE = "watermark.json";

export type DreamWatermark = {
  thread_summaries: number;
  extensions: Record<string, number>;
  extension_files: Record<string, number>;
};

export type DreamExtensionEntry = {
  extension: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
};

export type DreamListResult = {
  watermark: DreamWatermark;
  threadSummaries: Array<{
    threadId: string;
    runId: string;
    agentType: string;
    rolloutSummary: string;
    sourceUpdatedAt: number;
  }>;
  extensions: DreamExtensionEntry[];
  instructions: Array<{ extension: string; path: string }>;
};

const memoriesDir = (stellaHome: string): string =>
  path.join(resolveStellaStatePath(stellaHome), "memories");

const extensionsDir = (stellaHome: string): string =>
  path.join(resolveStellaStatePath(stellaHome), "memories_extensions");

const watermarkPath = (stellaHome: string): string =>
  path.join(memoriesDir(stellaHome), DREAM_WATERMARK_FILE);

const toExtensionFileKey = (root: string, filePath: string): string =>
  path.relative(root, filePath).split(path.sep).join("/");

const isWithinDirectory = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const normalizePath = async (target: string): Promise<string> => {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
};

export const readDreamWatermark = async (
  stellaHome: string,
): Promise<DreamWatermark> => {
  try {
    const raw = await fs.readFile(watermarkPath(stellaHome), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DreamWatermark> | null;
    return {
      thread_summaries:
        typeof parsed?.thread_summaries === "number" ? parsed.thread_summaries : 0,
      extensions:
        parsed?.extensions && typeof parsed.extensions === "object"
          ? Object.fromEntries(
              Object.entries(parsed.extensions).filter(
                ([, v]) => typeof v === "number" && Number.isFinite(v),
              ),
            ) as Record<string, number>
          : {},
      extension_files:
        parsed?.extension_files && typeof parsed.extension_files === "object"
          ? Object.fromEntries(
              Object.entries(parsed.extension_files).filter(
                ([, v]) => typeof v === "number" && Number.isFinite(v),
              ),
            ) as Record<string, number>
          : {},
    };
  } catch {
    return { thread_summaries: 0, extensions: {}, extension_files: {} };
  }
};

export const writeDreamWatermark = async (
  stellaHome: string,
  watermark: DreamWatermark,
): Promise<void> => {
  const dir = memoriesDir(stellaHome);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    watermarkPath(stellaHome),
    `${JSON.stringify(watermark, null, 2)}\n`,
    "utf-8",
  );
};

const listExtensionFiles = async (
  stellaHome: string,
  watermark: DreamWatermark,
): Promise<{ entries: DreamExtensionEntry[]; instructions: Array<{ extension: string; path: string }> }> => {
  const root = extensionsDir(stellaHome);
  let extensions: string[];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    extensions = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { entries: [], instructions: [] };
  }

  const entries: DreamExtensionEntry[] = [];
  const instructions: Array<{ extension: string; path: string }> = [];
  const extensionsWithPerFileState = new Set(
    Object.keys(watermark.extension_files)
      .map((fileKey) => fileKey.split("/")[0]?.trim())
      .filter((extension): extension is string => Boolean(extension)),
  );

  for (const extension of extensions) {
    const extDir = path.join(root, extension);
    const legacySince = extensionsWithPerFileState.has(extension)
      ? 0
      : (watermark.extensions[extension] ?? 0);

    try {
      const files = await fs.readdir(extDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const filePath = path.join(extDir, f.name);
        if (f.name === "instructions.md") {
          instructions.push({ extension, path: filePath });
          continue;
        }
        if (!f.name.endsWith(".md") && !f.name.endsWith(".jsonl")) continue;
        try {
          const stat = await fs.stat(filePath);
          const fileKey = toExtensionFileKey(root, filePath);
          const fileSince = watermark.extension_files[fileKey] ?? 0;
          const since = Math.max(legacySince, fileSince);
          if (stat.mtimeMs <= since) continue;
          entries.push({
            extension,
            path: filePath,
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
          });
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { entries, instructions };
};

export const dreamList = async (args: {
  stellaHome: string;
  store: ThreadSummariesStore;
  sinceWatermark?: number;
  limit?: number;
}): Promise<DreamListResult> => {
  const watermark = await readDreamWatermark(args.stellaHome);
  // Thread summaries are already durable queue rows with processed_by_dream_at.
  // Do not apply the persisted watermark by default or we can skip rows that
  // share the same millisecond timestamp as a partially processed batch.
  const sinceTs = args.sinceWatermark ?? 0;
  const rows = args.store.listUnprocessed({
    sinceWatermark: sinceTs,
    limit: args.limit,
  });

  const { entries, instructions } = await listExtensionFiles(
    args.stellaHome,
    watermark,
  );

  return {
    watermark,
    threadSummaries: rows.map((row) => ({
      threadId: row.threadId,
      runId: row.runId,
      agentType: row.agentType,
      rolloutSummary: row.rolloutSummary,
      sourceUpdatedAt: row.sourceUpdatedAt,
    })),
    extensions: entries,
    instructions,
  };
};

export type DreamMarkProcessedArgs = {
  stellaHome: string;
  store: ThreadSummariesStore;
  threadKeys?: Array<{ threadId: string; runId: string }>;
  threadIds?: string[];
  extensionPaths?: string[];
  watermark?: number;
};

export const dreamMarkProcessed = async (
  args: DreamMarkProcessedArgs,
): Promise<{ updated: number; watermark: DreamWatermark }> => {
  const baseUpdate = args.store.markProcessed({
    threadKeys: args.threadKeys,
    threadIds: args.threadIds,
    ...(typeof args.watermark === "number" ? { watermark: args.watermark } : {}),
  });

  const current = await readDreamWatermark(args.stellaHome);
  const nextThreadWatermark =
    typeof args.watermark === "number"
      ? Math.max(current.thread_summaries, args.watermark)
      : baseUpdate.maxSourceUpdatedAt > 0
        ? Math.max(current.thread_summaries, baseUpdate.watermark)
        : current.thread_summaries;
  const next: DreamWatermark = {
    thread_summaries: nextThreadWatermark,
    extensions: { ...current.extensions },
    extension_files: { ...current.extension_files },
  };

  const extensionsRoot = await normalizePath(extensionsDir(args.stellaHome));
  for (const filePath of args.extensionPaths ?? []) {
    const normalizedFilePath = await normalizePath(filePath);
    if (!isWithinDirectory(normalizedFilePath, extensionsRoot)) {
      continue;
    }
    const segments = normalizedFilePath.split(path.sep);
    const idx = segments.indexOf("memories_extensions");
    if (idx === -1 || idx + 1 >= segments.length) continue;
    const extension = segments[idx + 1]!;
    try {
      const stat = await fs.stat(normalizedFilePath);
      const fileKey = toExtensionFileKey(extensionsRoot, normalizedFilePath);
      delete next.extensions[extension];
      next.extension_files[fileKey] = Math.max(
        next.extension_files[fileKey] ?? 0,
        stat.mtimeMs,
      );
    } catch {
      continue;
    }
  }

  await writeDreamWatermark(args.stellaHome, next);

  return { updated: baseUpdate.updated, watermark: next };
};

export const countPendingDreamExtensions = async (
  stellaHome: string,
): Promise<number> => {
  const watermark = await readDreamWatermark(stellaHome);
  const { entries } = await listExtensionFiles(stellaHome, watermark);
  return entries.length;
};
