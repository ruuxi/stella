/**
 * Feature roster: collapses Stella self-mod commit history into one entry
 * per `Stella-Feature-Id` group, with installed add-on footprints alongside.
 *
 * Used by:
 *   - The commit-message LLM at commit-finalize time. The model picks
 *     either an existing `featureId` from this roster or invents a new
 *     one, given the current commit's diff + the installed-add-on
 *     footprints (which it uses to decide whether the commit extends an
 *     installed add-on).
 *   - The Store side panel, which renders one row per feature group.
 *
 * Inputs are parameterized for testability: the production builder
 * (`buildFeatureRoster`) wraps git/SQLite access; the pure collapser
 * (`collapseFeatureRosterFromCommits`) takes in-memory commit records.
 */

import {
  getChangedFilesForCommits,
  listStellaFeatureCommitsRaw,
  parseStellaCommitTrailers,
} from "./git.js";
import type { StoreModStore } from "../storage/store-mod-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RawFeatureCommit = {
  hash: string;
  timestampMs: number;
  subject: string;
  body: string;
};

/**
 * One feature group's collapsed view. The LLM reads these from the
 * prompt and either picks one's `featureId` or returns a new id.
 */
export type FeatureRosterEntry = {
  featureId: string;
  /** Latest commit's `Stella-Feature-Title`, or the latest subject if title is missing. */
  latestTitle: string;
  totalCommits: number;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Up to ~10 representative paths touched across this feature's commits. */
  fileFingerprint: string[];
  /** Union of every `Stella-Parent-Package-Id` ever seen in this feature group. */
  parentPackageIds: string[];
  /**
   * `Stella-Package-Id` if this feature was ever published — used by the
   * pruner to keep published features around forever even if they fall
   * outside the freshness window.
   */
  publishedPackageId?: string;
};

export type InstalledAddonFootprint = {
  packageId: string;
  releaseNumber: number;
  /** Up to ~12 representative files this install touched. */
  fileFingerprint: string[];
};

export type FeatureRoster = {
  features: FeatureRosterEntry[];
  installedFootprints: InstalledAddonFootprint[];
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const FRESHNESS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const EVICTION_IMMUNITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FINGERPRINT_PATHS = 10;
const MAX_INSTALL_FINGERPRINT_PATHS = 12;
/**
 * Soft token budget for the roster block when serialized into the
 * commit-message prompt. This is intentionally a *byte* approximation
 * (`bytes / 4`) rather than a real tokenizer call — the LLM call is
 * already on the commit hot path and we don't want to load tiktoken
 * for a sizing heuristic. ~2k tokens => ~8k characters.
 */
const DEFAULT_ROSTER_TOKEN_BUDGET = 2_000;
const APPROX_BYTES_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Pure collapser
// ---------------------------------------------------------------------------

type Aggregator = {
  featureId: string;
  latestTitle: string;
  latestSubject: string;
  totalCommits: number;
  firstSeenMs: number;
  lastSeenMs: number;
  filePathHits: Map<string, number>;
  parentPackageIds: Set<string>;
  publishedPackageId?: string;
};

const pickTopFiles = (filePathHits: Map<string, number>, max: number): string[] => {
  return Array.from(filePathHits.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([path]) => path);
};

/**
 * Collapse a list of raw commit records into one aggregated row per
 * `Stella-Feature-Id`. Pure function — no git, no fs. The production
 * `buildFeatureRoster` wraps this; tests can call it directly.
 *
 * `filesByCommit` maps each commit hash to the files it touched. Pass
 * an empty map when file fingerprints are not needed.
 */
export const collapseFeatureRosterFromCommits = (
  commits: RawFeatureCommit[],
  filesByCommit: Map<string, string[]>,
): FeatureRosterEntry[] => {
  // Process commits newest-first (which is git log's default order) so
  // `latestTitle` ends up reflecting the most recent commit.
  const aggregators = new Map<string, Aggregator>();
  for (const commit of commits) {
    const trailers = parseStellaCommitTrailers(commit.body);
    if (!trailers.featureId) continue;
    const existing = aggregators.get(trailers.featureId);
    if (existing) {
      existing.totalCommits += 1;
      if (commit.timestampMs < existing.firstSeenMs) {
        existing.firstSeenMs = commit.timestampMs;
      }
      // Older commits run after the first one we saw (newest), so we
      // never overwrite the latest title — keep what we have.
      if (trailers.packageId && !existing.publishedPackageId) {
        existing.publishedPackageId = trailers.packageId;
      }
      for (const parent of trailers.parentPackageIds) {
        existing.parentPackageIds.add(parent);
      }
      const files = filesByCommit.get(commit.hash) ?? [];
      for (const path of files) {
        existing.filePathHits.set(path, (existing.filePathHits.get(path) ?? 0) + 1);
      }
    } else {
      const filePathHits = new Map<string, number>();
      const files = filesByCommit.get(commit.hash) ?? [];
      for (const path of files) {
        filePathHits.set(path, 1);
      }
      aggregators.set(trailers.featureId, {
        featureId: trailers.featureId,
        latestTitle: trailers.featureTitle?.trim() || commit.subject.trim() || "Untitled",
        latestSubject: commit.subject.trim(),
        totalCommits: 1,
        firstSeenMs: commit.timestampMs,
        lastSeenMs: commit.timestampMs,
        filePathHits,
        parentPackageIds: new Set(trailers.parentPackageIds),
        ...(trailers.packageId ? { publishedPackageId: trailers.packageId } : {}),
      });
    }
  }
  return Array.from(aggregators.values()).map((agg) => ({
    featureId: agg.featureId,
    latestTitle: agg.latestTitle,
    totalCommits: agg.totalCommits,
    firstSeenMs: agg.firstSeenMs,
    lastSeenMs: agg.lastSeenMs,
    fileFingerprint: pickTopFiles(agg.filePathHits, MAX_FINGERPRINT_PATHS),
    parentPackageIds: Array.from(agg.parentPackageIds).sort(),
    ...(agg.publishedPackageId ? { publishedPackageId: agg.publishedPackageId } : {}),
  }));
};

// ---------------------------------------------------------------------------
// Pruning + eviction
// ---------------------------------------------------------------------------

/**
 * Drop unpublished features untouched for > 90 days. Published features
 * always stay (they're real Store entities the system needs to be aware
 * of indefinitely).
 */
export const pruneStaleFeatures = (
  features: FeatureRosterEntry[],
  nowMs: number,
): FeatureRosterEntry[] => {
  const cutoff = nowMs - FRESHNESS_WINDOW_MS;
  return features.filter(
    (entry) => entry.publishedPackageId !== undefined || entry.lastSeenMs >= cutoff,
  );
};

const serializeRosterEntry = (entry: FeatureRosterEntry): string => {
  const parents =
    entry.parentPackageIds.length > 0
      ? ` parents: ${entry.parentPackageIds.join(", ")}`
      : "";
  const published = entry.publishedPackageId
    ? ` published-as: ${entry.publishedPackageId}`
    : "";
  const files =
    entry.fileFingerprint.length > 0 ? ` files: ${entry.fileFingerprint.join(", ")}` : "";
  return `- ${entry.featureId} "${entry.latestTitle}" - ${entry.totalCommits} commits, last ${new Date(entry.lastSeenMs).toISOString().slice(0, 10)}${published}${parents}${files}`;
};

const estimateBytes = (entries: FeatureRosterEntry[]): number =>
  entries.reduce((acc, entry) => acc + serializeRosterEntry(entry).length + 1, 0);

/**
 * Cap the serialized roster to a token budget. Eviction policy:
 *   - Anything touched in the last 30 days is immune.
 *   - Published features are immune.
 *   - Otherwise drop oldest `lastSeenMs` first until under budget.
 *
 * Returns features in newest-first order (`lastSeenMs` desc) so the
 * prompt reads chronologically.
 */
export const enforceRosterTokenBudget = (
  features: FeatureRosterEntry[],
  nowMs: number,
  tokenBudget = DEFAULT_ROSTER_TOKEN_BUDGET,
): FeatureRosterEntry[] => {
  const byteBudget = tokenBudget * APPROX_BYTES_PER_TOKEN;
  const sorted = [...features].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  if (estimateBytes(sorted) <= byteBudget) {
    return sorted;
  }
  const immunityCutoff = nowMs - EVICTION_IMMUNITY_WINDOW_MS;
  // Walk oldest → newest dropping non-immune entries until under budget.
  // Use indices on the sorted array so we preserve newest-first ordering
  // in the result.
  const dropped = new Set<string>();
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (estimateBytes(sorted.filter((entry) => !dropped.has(entry.featureId))) <= byteBudget) {
      break;
    }
    const candidate = sorted[index]!;
    if (candidate.publishedPackageId !== undefined) continue;
    if (candidate.lastSeenMs >= immunityCutoff) continue;
    dropped.add(candidate.featureId);
  }
  return sorted.filter((entry) => !dropped.has(entry.featureId));
};

// ---------------------------------------------------------------------------
// Installed add-on footprints
// ---------------------------------------------------------------------------

/**
 * Build install-footprint entries from a list of `InstalledStoreModRecord`s
 * (state="installed") and a `commitHash → files[]` map. Pure function;
 * test-friendly.
 */
export const buildInstalledFootprintsFromInstalls = (
  installs: Array<{
    packageId: string;
    releaseNumber: number;
    state: "installed" | "uninstalled";
    applyCommitHashes: string[];
  }>,
  filesByCommit: Map<string, string[]>,
): InstalledAddonFootprint[] => {
  const result: InstalledAddonFootprint[] = [];
  for (const install of installs) {
    if (install.state !== "installed") continue;
    const filePathHits = new Map<string, number>();
    for (const hash of install.applyCommitHashes) {
      const files = filesByCommit.get(hash) ?? [];
      for (const file of files) {
        filePathHits.set(file, (filePathHits.get(file) ?? 0) + 1);
      }
    }
    result.push({
      packageId: install.packageId,
      releaseNumber: install.releaseNumber,
      fileFingerprint: pickTopFiles(filePathHits, MAX_INSTALL_FINGERPRINT_PATHS),
    });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Production builder (wraps git + SQLite)
// ---------------------------------------------------------------------------

export const buildFeatureRoster = async (args: {
  repoRoot: string;
  store: StoreModStore;
  nowMs?: number;
  tokenBudget?: number;
  /**
   * How many recent self-mod commits to scan when building the
   * roster. Defaults to 4_000, which covers months of active dev.
   */
  commitScanLimit?: number;
}): Promise<FeatureRoster> => {
  const nowMs = args.nowMs ?? Date.now();
  const commits = await listStellaFeatureCommitsRaw(args.repoRoot, args.commitScanLimit);
  const featureCommitHashes = commits
    .filter((commit) => parseStellaCommitTrailers(commit.body).featureId !== undefined)
    .map((commit) => commit.hash);
  const installs = args.store.listInstalledMods();
  const installCommitHashes = installs.flatMap((install) => install.applyCommitHashes);
  const filesByCommit = await getChangedFilesForCommits(
    args.repoRoot,
    Array.from(new Set([...featureCommitHashes, ...installCommitHashes])),
  );

  let features = collapseFeatureRosterFromCommits(commits, filesByCommit);
  features = pruneStaleFeatures(features, nowMs);
  features = enforceRosterTokenBudget(features, nowMs, args.tokenBudget);

  const installedFootprints = buildInstalledFootprintsFromInstalls(
    installs,
    filesByCommit,
  );
  return { features, installedFootprints };
};

// ---------------------------------------------------------------------------
// Prompt formatter (used by `commitMessageProvider`)
// ---------------------------------------------------------------------------

export const formatRosterForPrompt = (roster: FeatureRoster): string => {
  const featureLines = roster.features.length === 0
    ? "(none yet)"
    : roster.features.map(serializeRosterEntry).join("\n");
  const installLines = roster.installedFootprints.length === 0
    ? "(none installed)"
    : roster.installedFootprints
        .map(
          (entry) =>
            `- ${entry.packageId} v${entry.releaseNumber} - files: ${entry.fileFingerprint.join(", ") || "(none recorded)"}`,
        )
        .join("\n");
  return [
    "Existing features in this Stella install:",
    featureLines,
    "",
    "Installed add-ons (with their file footprints):",
    installLines,
  ].join("\n");
};
