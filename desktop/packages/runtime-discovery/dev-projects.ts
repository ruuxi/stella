/**
 * Dev Projects Discovery
 *
 * Finds active development projects from real usage signals rather than
 * scanning hardcoded directories. Sources:
 *
 * 1. macOS Spotlight (mdfind) — instant discovery of all git repos on disk
 * 2. GitHub Desktop repositories.json — repos the user has cloned/opened
 * 3. JetBrains recent projects — WebStorm, IntelliJ, PyCharm, etc.
 *
 * All discovered repos are filtered to only include those where the user
 * has authored commits (matched against git config user.name/email).
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";

import type { DevProject } from "./types.js";

const log = (...args: unknown[]) => console.error("[dev-projects]", ...args);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RECENCY_DAYS = 30;

// ---------------------------------------------------------------------------
// Git Identity
// ---------------------------------------------------------------------------

type GitIdentity = {
  name?: string;
  email?: string;
};

const readGitIdentity = async (): Promise<GitIdentity> => {
  const gitConfigPath = path.join(os.homedir(), ".gitconfig");
  try {
    const content = await fs.readFile(gitConfigPath, "utf-8");
    const identity: GitIdentity = {};
    let inUserSection = false;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (/^\[user\]$/i.test(trimmed)) {
        inUserSection = true;
        continue;
      }
      if (trimmed.startsWith("[")) {
        inUserSection = false;
        continue;
      }
      if (!inUserSection) continue;

      const kv = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
      if (kv) {
        if (kv[1] === "name") identity.name = kv[2].trim();
        if (kv[1] === "email") identity.email = kv[2].trim();
      }
    }

    return identity;
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// Git Repo Validation
// ---------------------------------------------------------------------------

/**
 * Check if a directory is a git repo and get its last activity time.
 */
const getGitRepoActivity = async (dir: string): Promise<number | null> => {
  const gitDir = path.join(dir, ".git");

  try {
    const stat = await fs.stat(gitDir);
    if (!stat.isDirectory()) return null;

    const filesToCheck = [
      path.join(gitDir, "index"),
      path.join(gitDir, "HEAD"),
      path.join(gitDir, "FETCH_HEAD"),
      path.join(gitDir, "logs", "HEAD"),
    ];

    const fileStats = await Promise.all(
      filesToCheck.map((file) => fs.stat(file).catch(() => null)),
    );
    let mostRecent = 0;
    for (const fileStat of fileStats) {
      if (fileStat && fileStat.mtimeMs > mostRecent) {
        mostRecent = fileStat.mtimeMs;
      }
    }

    return mostRecent > 0 ? mostRecent : stat.mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Check if the user has authored any commits in a git repo.
 * Matches against git config user.name and user.email.
 */
const hasUserCommits = async (
  repoPath: string,
  identity: GitIdentity,
): Promise<boolean> => {
  if (!identity.name && !identity.email) return true; // can't filter, include it

  // Build --author args for each identity part
  const authorArgs: string[] = [];
  if (identity.email) authorArgs.push(`--author=${identity.email}`);
  else if (identity.name) authorArgs.push(`--author=${identity.name}`);

  const cmd = `git -C ${JSON.stringify(repoPath)} log ${authorArgs.map((a) => JSON.stringify(a)).join(" ")} --oneline -1 --since="${RECENCY_DAYS}.days.ago"`;

  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf-8", timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        // git log fails on empty repos or non-git dirs — exclude
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execAsync = (command: string, timeoutMs = 10000): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(
      command,
      { encoding: "utf-8", maxBuffer: 1024 * 512, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Source 1: macOS Spotlight (mdfind)
// ---------------------------------------------------------------------------

const collectFromSpotlight = async (): Promise<string[]> => {
  if (process.platform !== "darwin") return [];

  try {
    // mdfind returns all .git directories on disk instantly via the Spotlight index
    const output = await execAsync(
      'mdfind "kMDItemFSName == .git && kMDItemContentType == public.folder" -onlyin ~',
      15000,
    );
    if (!output) return [];

    return output
      .split("\n")
      .filter((line) => line.endsWith("/.git"))
      .map((line) => path.dirname(line));
  } catch {
    log("Spotlight query failed, skipping");
    return [];
  }
};

// ---------------------------------------------------------------------------
// Source 2: GitHub Desktop repositories.json
// ---------------------------------------------------------------------------

type GHDesktopRepo = {
  path?: string;
  missing?: boolean;
};

const collectFromGitHubDesktop = async (): Promise<string[]> => {
  const home = os.homedir();
  const platform = process.platform;

  let reposPath: string;
  if (platform === "win32") {
    reposPath = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "GitHub Desktop",
      "repositories.json",
    );
  } else if (platform === "darwin") {
    reposPath = path.join(
      home,
      "Library",
      "Application Support",
      "GitHub Desktop",
      "repositories.json",
    );
  } else {
    reposPath = path.join(home, ".config", "GitHub Desktop", "repositories.json");
  }

  try {
    if (!(await fileExists(reposPath))) return [];

    const content = await fs.readFile(reposPath, "utf-8");
    const repos: GHDesktopRepo[] = JSON.parse(content);

    return repos
      .filter((r) => r.path && !r.missing)
      .map((r) => r.path!);
  } catch {
    log("GitHub Desktop repos not found, skipping");
    return [];
  }
};

// ---------------------------------------------------------------------------
// Source 3: JetBrains Recent Projects
// ---------------------------------------------------------------------------

const JETBRAINS_IDES = [
  "IntelliJIdea",
  "WebStorm",
  "PyCharm",
  "Rider",
  "GoLand",
  "CLion",
  "RubyMine",
  "PhpStorm",
  "DataGrip",
  "RustRover",
];

const collectFromJetBrains = async (): Promise<string[]> => {
  const home = os.homedir();
  const platform = process.platform;

  let configBase: string;
  if (platform === "win32") {
    configBase = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "JetBrains",
    );
  } else if (platform === "darwin") {
    configBase = path.join(home, "Library", "Application Support", "JetBrains");
  } else {
    configBase = path.join(home, ".config", "JetBrains");
  }

  if (!(await fileExists(configBase))) return [];

  const results: string[] = [];

  try {
    const entries = await fs.readdir(configBase, { withFileTypes: true });

    // Find versioned IDE directories (e.g., "WebStorm2024.3", "IntelliJIdea2025.1")
    const ideDirs = entries.filter(
      (e) =>
        e.isDirectory() &&
        JETBRAINS_IDES.some((ide) => e.name.startsWith(ide)),
    );

    for (const ideDir of ideDirs) {
      const recentPath = path.join(
        configBase,
        ideDir.name,
        "options",
        "recentProjects.xml",
      );

      try {
        if (!(await fileExists(recentPath))) continue;

        const content = await fs.readFile(recentPath, "utf-8");

        // Extract project paths from XML — they appear as key="..." attributes
        // Format: <entry key="$USER_HOME$/projects/my-app">
        const pathMatches = content.matchAll(/key="([^"]+)"/g);
        for (const match of pathMatches) {
          let projectPath = match[1];
          // JetBrains uses $USER_HOME$ as placeholder
          projectPath = projectPath.replace(/\$USER_HOME\$/g, home);
          // Normalize path separators
          projectPath = projectPath.replace(/\//g, path.sep);

          if (projectPath && !projectPath.includes("$")) {
            results.push(projectPath);
          }
        }
      } catch {
        // Can't read this IDE's recent projects, skip
      }
    }
  } catch {
    log("JetBrains config not found, skipping");
  }

  return results;
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

export const collectDevProjects = async (): Promise<DevProject[]> => {
  log("Starting dev projects discovery...");

  const cutoffTime = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;

  // Collect candidate paths from all sources in parallel
  const [identity, spotlightPaths, ghDesktopPaths, jetbrainsPaths] =
    await Promise.all([
      readGitIdentity(),
      collectFromSpotlight(),
      collectFromGitHubDesktop(),
      collectFromJetBrains(),
    ]);

  log(
    `Candidates: spotlight=${spotlightPaths.length}, github-desktop=${ghDesktopPaths.length}, jetbrains=${jetbrainsPaths.length}`,
  );
  if (identity.name || identity.email) {
    log(`Git identity: ${identity.name || "?"} <${identity.email || "?"}>`);
  }

  // Deduplicate candidate paths
  const seen = new Set<string>();
  const candidatePaths: string[] = [];
  for (const p of [...spotlightPaths, ...ghDesktopPaths, ...jetbrainsPaths]) {
    const normalized = p.toLowerCase().replace(/[\\/]+$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidatePaths.push(p);
  }

  log(`${candidatePaths.length} unique candidate paths`);

  // Validate candidates in parallel (batched to avoid too many git processes)
  const batchSize = 15;
  const results: DevProject[] = [];

  for (let i = 0; i < candidatePaths.length; i += batchSize) {
    const batch = candidatePaths.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (projectPath): Promise<DevProject | null> => {
        const lastActivity = await getGitRepoActivity(projectPath);
        if (!lastActivity || lastActivity < cutoffTime) return null;

        const userOwned = await hasUserCommits(projectPath, identity);
        if (!userOwned) return null;

        return {
          name: path.basename(projectPath),
          path: projectPath,
          lastActivity,
        };
      }),
    );

    for (const result of batchResults) {
      if (result) results.push(result);
    }
  }

  // Sort by most recent activity
  results.sort((a, b) => b.lastActivity - a.lastActivity);

  // Limit to top 30
  const limited = results.slice(0, 30);

  log(`Found ${limited.length} active projects with user commits (last ${RECENCY_DAYS} days)`);

  return limited;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format dev projects for LLM synthesis.
 *
 * Projects are already sorted by most-recent-first from collection.
 * We cap at 8 for synthesis — enough to show active work, not so many
 * that stale projects from weeks ago dilute the signal.
 */
export const formatDevProjectsForSynthesis = (
  projects: DevProject[],
): string => {
  if (projects.length === 0) return "";

  const sections: string[] = ["## Active Projects"];

  sections.push(
    "\n" +
      projects
        .slice(0, 8)
        .map((p) => {
          const daysAgo = Math.floor(
            (Date.now() - p.lastActivity) / (24 * 60 * 60 * 1000),
          );
          const recency =
            daysAgo === 0
              ? "today"
              : daysAgo === 1
                ? "yesterday"
                : `${daysAgo}d ago`;
          return `- ${p.name} (${p.path}) (${recency})`;
        })
        .join("\n"),
  );

  return sections.join("\n");
};
