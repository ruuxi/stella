import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "../shared/private-fs.js";

/**
 * Reusable hash-history reconciliation of bundled entries into Stella home.
 *
 * Stella ships default content (skills, agent prompts, …) inside the install
 * tree. Users carry their own copy under `~/.stella/`. A one-shot seed would
 * leave shipped updates permanently shadowed by whatever each user first
 * booted against, so instead every entry is reconciled per-boot:
 *
 *   - Each entry (a directory for skills, a single file for agent prompts) is
 *     hashed as one unit. If the user touched it, it's treated as user-owned
 *     and left alone.
 *   - A manifest at `<homeDir>/<manifestFilename>` records the hash we last
 *     wrote for every entry we seeded. Next boot: home hash matches the
 *     recorded hash → safe to overwrite with the new bundled version; differs
 *     → user diverged, hands off.
 *   - Home entries with no bundled counterpart and no manifest entry (user-
 *     authored) are ignored.
 *
 * The directory-vs-file mechanics are pluggable via {@link BundledEntryAdapter}
 * so skills and backend-synchronized prompt snapshots share this one
 * algorithm.
 */

const MANIFEST_VERSION = 2 as const;

export type Sha256Hex = string;

export type BundledSyncAction =
  | { type: "seed"; id: string; bundledHash: Sha256Hex }
  | { type: "update"; id: string; bundledHash: Sha256Hex }
  | {
      type: "skip-user-modified";
      id: string;
      reason: "diverged" | "no-manifest";
    }
  | { type: "adopt-identical"; id: string; bundledHash: Sha256Hex }
  | { type: "remove-obsolete"; id: string }
  | { type: "skip-obsolete-user-modified"; id: string }
  | { type: "ignore-user-entry"; id: string };

export type BundledSyncReport = { actions: BundledSyncAction[] };

/** Per-unit filesystem operations (directory for skills, file for prompts). */
export type BundledEntryAdapter = {
  /** List entry ids in a directory (already filtered for validity). */
  listIds: (dir: string) => Promise<string[]>;
  /** Hash a single entry as one unit; null when it doesn't exist. */
  hash: (dir: string, id: string) => Promise<Sha256Hex | null>;
  /** Copy an entry from one directory to another (overwriting). */
  copy: (srcDir: string, destDir: string, id: string) => Promise<void>;
  /** Remove an entry from a directory. */
  remove: (dir: string, id: string) => Promise<void>;
};

export type BundledSyncOptions = {
  manifestFilename?: string;
  /** Filter which bundled ids participate (e.g. platform-exclusive skills). */
  includeBundledId?: (id: string) => boolean;
  /**
   * Legacy alias for the manifest's hash map, read once for installs seeded
   * before `entries` became the canonical key (skills-sync originally wrote
   * `skills`). Without it, an old manifest reads as `null` and every shipped
   * update to an untouched entry is misclassified as user-modified and
   * skipped. The next write always emits `entries`, so this self-heals after
   * the first boot.
   */
  legacyEntriesKey?: string;
  /** Revision of the canonical snapshot being reconciled. */
  sourceRevision?: string;
  /** Offline bootstrap mode: populate missing entries, never replace files. */
  seedMissingOnly?: boolean;
  /** Whether untouched entries absent from the source should be removed. */
  removeObsolete?: boolean;
};

const DEFAULT_MANIFEST_FILENAME = ".bundled-manifest.json";

export type BundledManifestEntry = {
  lastSyncedHash: Sha256Hex;
  sourceRevision: string;
  customized: boolean;
};

type BundledManifest = {
  version: typeof MANIFEST_VERSION;
  entries: Record<string, BundledManifestEntry>;
};

const readManifest = async (
  manifestPath: string,
  legacyEntriesKey?: string,
): Promise<BundledManifest | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.version !== 1 && record.version !== MANIFEST_VERSION) {
        return null;
      }
      // Prefer the canonical `entries` map, falling back to a caller-declared
      // legacy key so manifests written before the rename still apply updates.
      const rawEntries =
        record.entries ??
        (legacyEntriesKey ? record[legacyEntriesKey] : undefined);
      if (rawEntries && typeof rawEntries === "object") {
        const clean: Record<string, BundledManifestEntry> = {};
        for (const [id, value] of Object.entries(
          rawEntries as Record<string, unknown>,
        )) {
          if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) {
            clean[id] = {
              lastSyncedHash: value,
              sourceRevision: "bundled:legacy",
              customized: false,
            };
            continue;
          }
          if (value && typeof value === "object") {
            const entry = value as Partial<BundledManifestEntry>;
            if (
              typeof entry.lastSyncedHash === "string" &&
              /^[0-9a-f]{64}$/.test(entry.lastSyncedHash) &&
              typeof entry.sourceRevision === "string" &&
              typeof entry.customized === "boolean"
            ) {
              clean[id] = {
                lastSyncedHash: entry.lastSyncedHash,
                sourceRevision: entry.sourceRevision,
                customized: entry.customized,
              };
            }
          }
        }
        return { version: MANIFEST_VERSION, entries: clean };
      }
    }
  } catch {
    // Corrupt manifest — fall through to null and rebuild conservatively.
  }
  return null;
};

const writeManifest = async (
  manifestPath: string,
  manifest: BundledManifest,
): Promise<void> => {
  await ensurePrivateDir(path.dirname(manifestPath));
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const tempPath = `${manifestPath}.tmp`;
  await fs.writeFile(tempPath, serialized, "utf-8");
  await fs.rename(tempPath, manifestPath);
};

/**
 * Reconcile bundled entries into a Stella home directory. Returns a report of
 * every decision so callers can log a summary.
 */
export const reconcileBundledEntries = async (
  bundledDir: string,
  homeDir: string,
  adapter: BundledEntryAdapter,
  options: BundledSyncOptions = {},
): Promise<BundledSyncReport> => {
  await ensurePrivateDir(homeDir);

  const manifestPath = path.join(
    homeDir,
    options.manifestFilename ?? DEFAULT_MANIFEST_FILENAME,
  );
  const manifest =
    (await readManifest(manifestPath, options.legacyEntriesKey)) ??
    ({ version: MANIFEST_VERSION, entries: {} } as BundledManifest);
  const sourceRevision = options.sourceRevision?.trim() || "bundled";
  const seedMissingOnly = options.seedMissingOnly === true;

  const includeBundledId = options.includeBundledId ?? (() => true);
  const bundledIds = (await adapter.listIds(bundledDir)).filter(
    includeBundledId,
  );
  const homeIds = await adapter.listIds(homeDir);

  const actions: BundledSyncAction[] = [];
  const nextEntries: Record<string, BundledManifestEntry> = {
    ...manifest.entries,
  };

  // 1. Reconcile every bundled entry against home + manifest.
  for (const id of bundledIds) {
    const bundledHash = await adapter.hash(bundledDir, id);
    if (!bundledHash) continue;

    const homeHash = await adapter.hash(homeDir, id);
    const recorded = manifest.entries[id];
    const recordedHash = recorded?.lastSyncedHash;

    if (homeHash === null) {
      await adapter.copy(bundledDir, homeDir, id);
      nextEntries[id] = {
        lastSyncedHash: bundledHash,
        sourceRevision,
        customized: false,
      };
      actions.push({ type: "seed", id, bundledHash });
      continue;
    }

    if (seedMissingOnly) {
      // Bundled bootstrap runs after fresh/cached remote reconciliation. If a
      // file already exists, its remote/customization history is authoritative;
      // an older app bundle must not rewrite either the file or its metadata.
      if (recorded) {
        nextEntries[id] = recorded;
        continue;
      }
      if (homeHash !== bundledHash) {
        actions.push({
          type: "skip-user-modified",
          id,
          reason: "no-manifest",
        });
        continue;
      }
    }

    if (homeHash === bundledHash) {
      nextEntries[id] = {
        lastSyncedHash: bundledHash,
        sourceRevision,
        customized: false,
      };
      if (recordedHash !== bundledHash) {
        actions.push({ type: "adopt-identical", id, bundledHash });
      }
      continue;
    }

    if (
      !seedMissingOnly &&
      recordedHash !== undefined &&
      recordedHash === homeHash
    ) {
      // Bundled changed, user hasn't touched it. Adapters replace atomically;
      // removing first would create a crash window with no usable entry.
      await adapter.copy(bundledDir, homeDir, id);
      nextEntries[id] = {
        lastSyncedHash: bundledHash,
        sourceRevision,
        customized: false,
      };
      actions.push({ type: "update", id, bundledHash });
      continue;
    }

    // User diverged (or first run with no manifest entry). Never overwrite.
    nextEntries[id] = {
      lastSyncedHash: recordedHash ?? bundledHash,
      sourceRevision: recorded?.sourceRevision ?? sourceRevision,
      customized: true,
    };
    actions.push({
      type: "skip-user-modified",
      id,
      reason: recordedHash === undefined ? "no-manifest" : "diverged",
    });
  }

  // 2. Handle entries the bundle no longer ships.
  const bundledIdSet = new Set(bundledIds);
  for (const id of options.removeObsolete === false ? [] : homeIds) {
    if (bundledIdSet.has(id)) continue;
    const recorded = manifest.entries[id];
    const recordedHash = recorded?.lastSyncedHash;
    if (recordedHash === undefined) {
      actions.push({ type: "ignore-user-entry", id });
      continue;
    }
    const homeHash = await adapter.hash(homeDir, id);
    if (homeHash !== null && homeHash === recordedHash) {
      await adapter.remove(homeDir, id);
      delete nextEntries[id];
      actions.push({ type: "remove-obsolete", id });
    } else {
      nextEntries[id] = { ...recorded, customized: true };
      actions.push({ type: "skip-obsolete-user-modified", id });
    }
  }

  await writeManifest(manifestPath, {
    version: MANIFEST_VERSION,
    entries: nextEntries,
  });

  return { actions };
};

export const summarizeBundledSync = (report: BundledSyncReport): string => {
  const tally = {
    seeded: 0,
    updated: 0,
    adopted: 0,
    preserved: 0,
    removed: 0,
    preservedObsolete: 0,
    ignored: 0,
  };
  for (const action of report.actions) {
    switch (action.type) {
      case "seed":
        tally.seeded += 1;
        break;
      case "update":
        tally.updated += 1;
        break;
      case "adopt-identical":
        tally.adopted += 1;
        break;
      case "skip-user-modified":
        tally.preserved += 1;
        break;
      case "remove-obsolete":
        tally.removed += 1;
        break;
      case "skip-obsolete-user-modified":
        tally.preservedObsolete += 1;
        break;
      case "ignore-user-entry":
        tally.ignored += 1;
        break;
    }
  }
  const parts: string[] = [];
  if (tally.seeded) parts.push(`seeded=${tally.seeded}`);
  if (tally.updated) parts.push(`updated=${tally.updated}`);
  if (tally.adopted) parts.push(`adopted=${tally.adopted}`);
  if (tally.preserved) parts.push(`preserved=${tally.preserved}`);
  if (tally.removed) parts.push(`removed=${tally.removed}`);
  if (tally.preservedObsolete)
    parts.push(`preservedObsolete=${tally.preservedObsolete}`);
  if (tally.ignored) parts.push(`ignored=${tally.ignored}`);
  return parts.length === 0 ? "no-op" : parts.join(" ");
};

// Directory entry adapter — shared by skills (and any future dir-unit sync).
const listSubdirectoryIds = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

const listDirectoryFilesRelative = async (
  dir: string,
  prefix = "",
): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listDirectoryFilesRelative(full, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const hashDirectoryUnit = async (
  dir: string,
  id: string,
): Promise<Sha256Hex | null> => {
  const unitDir = path.join(dir, id);
  if (!(await pathExists(unitDir))) return null;
  const files = await listDirectoryFilesRelative(unitDir);
  const hash = createHash("sha256");
  for (const rel of files) {
    const content = await fs.readFile(path.join(unitDir, rel));
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
};

/**
 * Adapter for entries that are directories (e.g. skills). `isValidId` lets a
 * caller exclude reserved ids (e.g. the user-profile skill).
 */
export const createDirectoryEntryAdapter = (
  isValidId: (id: string) => boolean = () => true,
): BundledEntryAdapter => ({
  listIds: async (dir) => (await listSubdirectoryIds(dir)).filter(isValidId),
  hash: hashDirectoryUnit,
  copy: async (srcDir, destDir, id) => {
    await ensurePrivateDir(destDir);
    const source = path.join(srcDir, id);
    const target = path.join(destDir, id);
    const nonce = `${process.pid}-${Date.now()}`;
    const staging = path.join(destDir, `.${id}.staging-${nonce}`);
    const backup = path.join(destDir, `.${id}.backup-${nonce}`);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.cp(source, staging, {
      recursive: true,
      force: true,
    });
    let movedExisting = false;
    try {
      if (await pathExists(target)) {
        await fs.rename(target, backup);
        movedExisting = true;
      }
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      if (movedExisting) {
        await fs.rename(backup, target).catch(() => {});
      }
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    if (movedExisting) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
  },
  remove: async (dir, id) => {
    await fs.rm(path.join(dir, id), { recursive: true, force: true });
  },
});

/**
 * Adapter for entries that are single files with a fixed extension (e.g.
 * agent prompts as `<id>.md`). Ids are basenames without the extension.
 */
export const createFileEntryAdapter = (
  extension: string,
): BundledEntryAdapter => {
  const fileName = (id: string) => `${id}${extension}`;
  return {
    listIds: async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.name.startsWith(".") &&
            entry.name.endsWith(extension),
        )
        .map((entry) => entry.name.slice(0, -extension.length))
        .sort((a, b) => a.localeCompare(b));
    },
    hash: async (dir, id) => {
      const filePath = path.join(dir, fileName(id));
      let content: Buffer;
      try {
        content = await fs.readFile(filePath);
      } catch {
        return null;
      }
      return createHash("sha256").update(content).digest("hex");
    },
    copy: async (srcDir, destDir, id) => {
      await ensurePrivateDir(destDir);
      const target = path.join(destDir, fileName(id));
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await fs.copyFile(path.join(srcDir, fileName(id)), temp);
      try {
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    },
    remove: async (dir, id) => {
      await fs.rm(path.join(dir, fileName(id)), { force: true });
    },
  };
};
