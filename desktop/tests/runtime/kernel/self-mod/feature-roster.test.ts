import { describe, expect, it } from "vitest";
import {
  buildInstalledFootprintsFromInstalls,
  collapseFeatureRosterFromCommits,
  enforceRosterTokenBudget,
  formatRosterForPrompt,
  pruneStaleFeatures,
  type FeatureRosterEntry,
  type RawFeatureCommit,
} from "../../../../../runtime/kernel/self-mod/feature-roster.js";

const NOW = Date.UTC(2026, 3, 29);
const DAY = 24 * 60 * 60 * 1000;

const commit = (
  args: {
    hash: string;
    daysAgo: number;
    subject?: string;
    featureId?: string;
    featureTitle?: string;
    parents?: string[];
    packageId?: string;
  },
): RawFeatureCommit => {
  const trailerLines: string[] = [];
  if (args.featureId) trailerLines.push(`Stella-Feature-Id: ${args.featureId}`);
  if (args.featureTitle) trailerLines.push(`Stella-Feature-Title: ${args.featureTitle}`);
  for (const parent of args.parents ?? []) {
    trailerLines.push(`Stella-Parent-Package-Id: ${parent}`);
  }
  if (args.packageId) trailerLines.push(`Stella-Package-Id: ${args.packageId}`);
  return {
    hash: args.hash,
    timestampMs: NOW - args.daysAgo * DAY,
    subject: args.subject ?? "(subject)",
    body: trailerLines.join("\n"),
  };
};

describe("collapseFeatureRosterFromCommits", () => {
  it("collapses commits that share a featureId into one entry", () => {
    const commits: RawFeatureCommit[] = [
      commit({ hash: "h3", daysAgo: 1, featureId: "feat:snake", featureTitle: "Snake game v3" }),
      commit({ hash: "h2", daysAgo: 2, featureId: "feat:snake", featureTitle: "Snake game v2" }),
      commit({ hash: "h1", daysAgo: 3, featureId: "feat:snake", featureTitle: "Snake game v1" }),
    ];
    const filesByCommit = new Map<string, string[]>([
      ["h1", ["snake/board.ts"]],
      ["h2", ["snake/board.ts", "snake/score.ts"]],
      ["h3", ["snake/score.ts"]],
    ]);
    const rows = collapseFeatureRosterFromCommits(commits, filesByCommit);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.featureId).toBe("feat:snake");
    expect(row.totalCommits).toBe(3);
    // First commit in the input is the newest; latestTitle reflects it.
    expect(row.latestTitle).toBe("Snake game v3");
    expect(row.firstSeenMs).toBe(NOW - 3 * DAY);
    expect(row.lastSeenMs).toBe(NOW - 1 * DAY);
    expect(row.fileFingerprint).toEqual(["snake/board.ts", "snake/score.ts"]);
    expect(row.parentPackageIds).toEqual([]);
  });

  it("skips commits without a Stella-Feature-Id trailer", () => {
    const commits: RawFeatureCommit[] = [
      commit({ hash: "h1", daysAgo: 1 /* no featureId */ }),
      commit({ hash: "h2", daysAgo: 2, featureId: "feat:keep" }),
    ];
    const rows = collapseFeatureRosterFromCommits(commits, new Map());
    expect(rows.map((r) => r.featureId)).toEqual(["feat:keep"]);
  });

  it("unions parent package ids across commits", () => {
    const commits: RawFeatureCommit[] = [
      commit({ hash: "h2", daysAgo: 1, featureId: "feat:x", parents: ["alpha"] }),
      commit({ hash: "h1", daysAgo: 2, featureId: "feat:x", parents: ["beta", "alpha"] }),
    ];
    const rows = collapseFeatureRosterFromCommits(commits, new Map());
    expect(rows[0]!.parentPackageIds).toEqual(["alpha", "beta"]);
  });

  it("captures publishedPackageId from any commit in the group", () => {
    const commits: RawFeatureCommit[] = [
      commit({ hash: "h2", daysAgo: 1, featureId: "feat:x" }),
      commit({ hash: "h1", daysAgo: 2, featureId: "feat:x", packageId: "snake-game" }),
    ];
    const rows = collapseFeatureRosterFromCommits(commits, new Map());
    expect(rows[0]!.publishedPackageId).toBe("snake-game");
  });

  it("prefers latest commit's title; falls back to subject when title missing", () => {
    const commits: RawFeatureCommit[] = [
      commit({
        hash: "h2",
        daysAgo: 1,
        featureId: "feat:x",
        subject: "Add multiplayer rooms",
      }),
      commit({
        hash: "h1",
        daysAgo: 2,
        featureId: "feat:x",
        featureTitle: "Snake game",
      }),
    ];
    const rows = collapseFeatureRosterFromCommits(commits, new Map());
    expect(rows[0]!.latestTitle).toBe("Add multiplayer rooms");
  });
});

describe("pruneStaleFeatures", () => {
  const make = (overrides: Partial<FeatureRosterEntry>): FeatureRosterEntry => ({
    featureId: overrides.featureId ?? "feat:x",
    latestTitle: overrides.latestTitle ?? "title",
    totalCommits: overrides.totalCommits ?? 1,
    firstSeenMs: overrides.firstSeenMs ?? NOW - 100 * DAY,
    lastSeenMs: overrides.lastSeenMs ?? NOW - 100 * DAY,
    fileFingerprint: overrides.fileFingerprint ?? [],
    parentPackageIds: overrides.parentPackageIds ?? [],
    ...(overrides.publishedPackageId
      ? { publishedPackageId: overrides.publishedPackageId }
      : {}),
  });

  it("drops unpublished features outside the 90-day window", () => {
    const entries = [
      make({ featureId: "fresh", lastSeenMs: NOW - 30 * DAY }),
      make({ featureId: "stale", lastSeenMs: NOW - 100 * DAY }),
    ];
    const result = pruneStaleFeatures(entries, NOW);
    expect(result.map((e) => e.featureId)).toEqual(["fresh"]);
  });

  it("keeps published features regardless of age", () => {
    const entries = [
      make({ featureId: "old-published", lastSeenMs: NOW - 365 * DAY, publishedPackageId: "snake" }),
    ];
    const result = pruneStaleFeatures(entries, NOW);
    expect(result.map((e) => e.featureId)).toEqual(["old-published"]);
  });
});

describe("enforceRosterTokenBudget", () => {
  const padding = "x".repeat(900); // make each entry's serialized form heavy
  const make = (
    featureId: string,
    daysAgo: number,
    overrides: Partial<FeatureRosterEntry> = {},
  ): FeatureRosterEntry => ({
    featureId,
    latestTitle: padding,
    totalCommits: 1,
    firstSeenMs: NOW - daysAgo * DAY,
    lastSeenMs: NOW - daysAgo * DAY,
    fileFingerprint: [],
    parentPackageIds: [],
    ...overrides,
  });

  it("returns sorted newest-first when under budget", () => {
    const entries = [
      make("a", 5),
      make("b", 1),
      make("c", 10),
    ];
    const result = enforceRosterTokenBudget(entries, NOW, 100_000);
    expect(result.map((e) => e.featureId)).toEqual(["b", "a", "c"]);
  });

  it("evicts oldest non-immune entries first to fit the budget", () => {
    const entries = [
      make("recent", 5), // immune (within 30 days)
      make("old1", 60),
      make("old2", 80),
      make("old3", 70),
    ];
    // Each entry serializes to ~950 bytes; budget of 800 tokens = 3200 bytes => fits ~3 entries
    const result = enforceRosterTokenBudget(entries, NOW, 800);
    expect(result.map((e) => e.featureId)).toContain("recent");
    // Oldest (old2 at 80 days) should be the first to evict.
    expect(result.map((e) => e.featureId)).not.toContain("old2");
  });

  it("never evicts published features", () => {
    const entries = [
      make("recent", 1),
      make("published-old", 200, { publishedPackageId: "snake" }),
      make("unpublished-old1", 100),
      make("unpublished-old2", 110),
    ];
    const result = enforceRosterTokenBudget(entries, NOW, 800);
    expect(result.map((e) => e.featureId)).toContain("published-old");
  });

  it("never evicts entries within the 30-day immunity window", () => {
    const entries = [
      make("a", 5),
      make("b", 10),
      make("c", 15),
      make("d", 20),
      make("e", 25),
    ];
    // All immune, so even with a tiny budget nothing is dropped.
    const result = enforceRosterTokenBudget(entries, NOW, 100);
    expect(result).toHaveLength(5);
  });
});

describe("buildInstalledFootprintsFromInstalls", () => {
  it("builds footprints from each installed mod's apply commits", () => {
    const installs = [
      {
        packageId: "snake-game",
        releaseNumber: 3,
        state: "installed" as const,
        applyCommitHashes: ["c1", "c2"],
      },
      {
        packageId: "old-uninstalled",
        releaseNumber: 1,
        state: "uninstalled" as const,
        applyCommitHashes: ["c0"],
      },
    ];
    const filesByCommit = new Map<string, string[]>([
      ["c1", ["snake/board.ts"]],
      ["c2", ["snake/score.ts", "snake/board.ts"]],
      ["c0", ["leftover.ts"]],
    ]);
    const result = buildInstalledFootprintsFromInstalls(installs, filesByCommit);
    expect(result).toHaveLength(1);
    expect(result[0]!.packageId).toBe("snake-game");
    // board.ts has more hits, comes first.
    expect(result[0]!.fileFingerprint).toEqual(["snake/board.ts", "snake/score.ts"]);
  });

  it("returns an empty fingerprint when files map has no records for the install", () => {
    const installs = [
      {
        packageId: "ghost",
        releaseNumber: 1,
        state: "installed" as const,
        applyCommitHashes: ["unknown"],
      },
    ];
    const result = buildInstalledFootprintsFromInstalls(installs, new Map());
    expect(result[0]!.fileFingerprint).toEqual([]);
  });
});

describe("formatRosterForPrompt", () => {
  it("renders both feature and installed sections in a stable shape", () => {
    const out = formatRosterForPrompt({
      features: [
        {
          featureId: "feat:snake",
          latestTitle: "Snake game",
          totalCommits: 5,
          firstSeenMs: NOW - 30 * DAY,
          lastSeenMs: NOW - 1 * DAY,
          fileFingerprint: ["snake/board.ts"],
          parentPackageIds: [],
          publishedPackageId: "snake-game",
        },
      ],
      installedFootprints: [
        { packageId: "dark-theme", releaseNumber: 2, fileFingerprint: ["theme.css"] },
      ],
    });
    expect(out).toContain("feat:snake");
    expect(out).toContain("Snake game");
    expect(out).toContain("snake-game");
    expect(out).toContain("dark-theme v2");
    expect(out).toContain("theme.css");
  });

  it("handles empty roster gracefully", () => {
    const out = formatRosterForPrompt({ features: [], installedFootprints: [] });
    expect(out).toContain("(none yet)");
    expect(out).toContain("(none installed)");
  });
});
