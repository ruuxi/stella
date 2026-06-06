/**
 * Dev Projects Discovery
 *
 * Finds active development projects from real usage signals. The goal is not
 * to enumerate every repo on disk; it is to rank the projects the user is most
 * likely to mean when they say "open my project".
 *
 * Sources:
 * 1. macOS Spotlight (mdfind) — broad git repo discovery when indexed
 * 2. GitHub Desktop repositories.json — repos the user has cloned/opened
 * 3. JetBrains recent projects — WebStorm, IntelliJ, PyCharm, etc.
 * 4. VS Code / Cursor recent workspaces and repository tracker
 * 5. Shell history `cd` targets
 * 6. Shallow scan of common development roots
 *
 * Candidates are resolved to git repository roots, scored, and filtered by
 * confidence. Recent authored commits help, but are not required: editor and
 * shell activity are often better onboarding signals than commit authorship.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec, execFile } from "child_process";
import { pathToFileURL } from "node:url";

import type { DevProject } from "./types.js";

const log = (...args: unknown[]) => console.error("[dev-projects]", ...args);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RECENCY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATE_PATHS = 240;
const MAX_VALIDATION_BATCH_SIZE = 8;
const MAX_RESULTS = 30;
const MIN_PROJECT_SCORE = 18;

const COMMON_DEV_ROOT_NAMES = [
  "projects",
  "Developer",
  "dev",
  "src",
  "code",
  "work",
  "repos",
];

const DEV_ROOT_SCAN_MAX_DEPTH = 2;
const DEV_ROOT_SCAN_MAX_DIRS = 500;
const DEV_ROOT_SCAN_MAX_REPOS = 100;

const PROJECT_MANIFESTS = [
  "package.json",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Package.swift",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "docker-compose.yml",
  "Dockerfile",
  "convex.json",
  "next.config.js",
  "vite.config.ts",
  "src-tauri",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GitIdentity = {
  name?: string;
  email?: string;
};

type ProjectCandidate = {
  path: string;
  sources: Map<string, number>;
  editorLastAccessed?: number;
};

type ResolvedProjectCandidate = {
  path: string;
  sources: Map<string, number>;
  editorLastAccessed?: number;
};

type ScoredProject = DevProject & {
  score: number;
  sourceSummary: string[];
};

type EditorWorkspace = {
  path: string;
};

type EditorTrackedRepo = {
  path: string;
  lastAccessed?: number;
};

type SqliteDatabase = {
  query(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeCandidatePath = (candidatePath: string): string | null => {
  let normalized = candidatePath.trim();
  if (!normalized) return null;

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original path if decoding fails.
  }

  normalized = normalized
    .replace(/^file:\/\/\//, "/")
    .replace(/^file:\/\//, "")
    .replace(/^vscode-remote:\/\/[^/]+/, "");

  if (normalized.startsWith("~")) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }

  normalized = normalized.replace(/[\\/]+$/, "");
  if (!normalized) return null;
  if (normalized.includes(`${path.sep}.vscode${path.sep}extensions`)) {
    return null;
  }
  if (normalized.includes("debugpy")) return null;

  return normalized;
};

const candidateKey = (candidatePath: string): string =>
  candidatePath.toLowerCase().replace(/[\\/]+$/, "");

const addCandidate = (
  candidates: Map<string, ProjectCandidate>,
  candidatePath: string | null | undefined,
  source: string,
  weight: number,
  metadata?: { editorLastAccessed?: number },
): void => {
  if (!candidatePath) return;
  const normalized = normalizeCandidatePath(candidatePath);
  if (!normalized) return;

  const key = candidateKey(normalized);
  const existing = candidates.get(key) ?? {
    path: normalized,
    sources: new Map<string, number>(),
  };
  existing.sources.set(source, (existing.sources.get(source) ?? 0) + weight);

  if (
    metadata?.editorLastAccessed &&
    (!existing.editorLastAccessed ||
      metadata.editorLastAccessed > existing.editorLastAccessed)
  ) {
    existing.editorLastAccessed = metadata.editorLastAccessed;
  }

  candidates.set(key, existing);
};

const execAsync = (command: string, timeoutMs = 10000): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(
      command,
      {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const execFileAsync = (
  file: string,
  args: string[],
  timeoutMs = 3000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf-8",
        maxBuffer: 1024 * 128,
        timeout: timeoutMs,
        windowsHide: true,
      },
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

const statIfExists = async (filePath: string) =>
  fs.stat(filePath).catch(() => null);

const daysAgo = (timestamp: number): number =>
  Math.floor((Date.now() - timestamp) / DAY_MS);

const sourceList = (sources: Map<string, number>): string[] =>
  Array.from(sources.keys()).sort();

// ---------------------------------------------------------------------------
// Git Identity
// ---------------------------------------------------------------------------

const parseGitIdentity = (content: string): GitIdentity => {
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
};

const readGlobalGitIdentity = async (): Promise<GitIdentity> => {
  const gitConfigPath = path.join(os.homedir(), ".gitconfig");
  try {
    return parseGitIdentity(await fs.readFile(gitConfigPath, "utf-8"));
  } catch {
    return {};
  }
};

const readRepoGitIdentity = async (repoPath: string): Promise<GitIdentity> => {
  const identity: GitIdentity = {};

  try {
    const email = await execFileAsync(
      "git",
      ["-C", repoPath, "config", "--get", "user.email"],
      1500,
    );
    if (email) identity.email = email;
  } catch {
    // Missing local config is fine.
  }

  try {
    const name = await execFileAsync(
      "git",
      ["-C", repoPath, "config", "--get", "user.name"],
      1500,
    );
    if (name) identity.name = name;
  } catch {
    // Missing local config is fine.
  }

  return identity;
};

// ---------------------------------------------------------------------------
// Git Repo Validation
// ---------------------------------------------------------------------------

const resolveGitRoot = async (
  candidatePath: string,
): Promise<string | null> => {
  try {
    const root = await execFileAsync(
      "git",
      ["-C", candidatePath, "rev-parse", "--show-toplevel"],
      3000,
    );
    return root || null;
  } catch {
    return null;
  }
};

const getGitRepoActivity = async (repoPath: string): Promise<number | null> => {
  const gitDir = path.join(repoPath, ".git");
  const filesToCheck = [
    path.join(gitDir, "index"),
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "FETCH_HEAD"),
    path.join(gitDir, "logs", "HEAD"),
  ];

  const fileStats = await Promise.all(
    filesToCheck.map((file) => statIfExists(file)),
  );
  let mostRecent = 0;
  for (const fileStat of fileStats) {
    if (fileStat && fileStat.mtimeMs > mostRecent) {
      mostRecent = fileStat.mtimeMs;
    }
  }

  const gitStat = await statIfExists(gitDir);
  if (!mostRecent && gitStat) mostRecent = gitStat.mtimeMs;

  if (mostRecent > 0) return mostRecent;

  try {
    const commitTimestamp = await execFileAsync(
      "git",
      ["-C", repoPath, "log", "-1", "--format=%ct"],
      3000,
    );
    const seconds = Number(commitTimestamp);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
};

const hasRecentAuthoredCommit = async (
  repoPath: string,
  globalIdentity: GitIdentity,
): Promise<boolean | null> => {
  const localIdentity = await readRepoGitIdentity(repoPath);
  const identities = [localIdentity, globalIdentity].filter(
    (identity) => identity.email || identity.name,
  );

  if (identities.length === 0) return null;

  for (const identity of identities) {
    const author = identity.email || identity.name;
    if (!author) continue;

    try {
      const output = await execFileAsync(
        "git",
        [
          "-C",
          repoPath,
          "log",
          `--author=${author}`,
          "--oneline",
          "-1",
          `--since=${RECENCY_DAYS}.days.ago`,
        ],
        3000,
      );
      if (output.length > 0) return true;
    } catch {
      // Try the next available identity.
    }
  }

  return false;
};

const countProjectManifests = async (repoPath: string): Promise<number> => {
  const hits = await Promise.all(
    PROJECT_MANIFESTS.map((manifest) =>
      fileExists(path.join(repoPath, manifest)),
    ),
  );
  return hits.filter(Boolean).length;
};

// ---------------------------------------------------------------------------
// Source 1: macOS Spotlight (mdfind)
// ---------------------------------------------------------------------------

const collectFromSpotlight = async (): Promise<string[]> => {
  if (process.platform !== "darwin") return [];

  try {
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
    reposPath = path.join(
      home,
      ".config",
      "GitHub Desktop",
      "repositories.json",
    );
  }

  try {
    if (!(await fileExists(reposPath))) return [];

    const content = await fs.readFile(reposPath, "utf-8");
    const repos: GHDesktopRepo[] = JSON.parse(content);

    return repos.filter((r) => r.path && !r.missing).map((r) => r.path!);
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

    const ideDirs = entries.filter(
      (e) =>
        e.isDirectory() && JETBRAINS_IDES.some((ide) => e.name.startsWith(ide)),
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
        const pathMatches = content.matchAll(/key="([^"]+)"/g);
        for (const match of pathMatches) {
          let projectPath = match[1];
          projectPath = projectPath.replace(/\$USER_HOME\$/g, home);
          projectPath = projectPath.replace(/\//g, path.sep);

          if (projectPath && !projectPath.includes("$")) {
            results.push(projectPath);
          }
        }
      } catch {
        // Can't read this IDE's recent projects, skip.
      }
    }
  } catch {
    log("JetBrains config not found, skipping");
  }

  return results;
};

// ---------------------------------------------------------------------------
// Source 4: VS Code / Cursor state
// ---------------------------------------------------------------------------

const getEditorConfigs = (): { name: string; dbPath: string }[] => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    return [
      {
        name: "cursor",
        dbPath: path.join(
          home,
          "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
        ),
      },
      {
        name: "vscode",
        dbPath: path.join(
          home,
          "AppData/Roaming/Code/User/globalStorage/state.vscdb",
        ),
      },
    ];
  }

  if (platform === "darwin") {
    return [
      {
        name: "cursor",
        dbPath: path.join(
          home,
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
        ),
      },
      {
        name: "vscode",
        dbPath: path.join(
          home,
          "Library/Application Support/Code/User/globalStorage/state.vscdb",
        ),
      },
    ];
  }

  return [
    {
      name: "cursor",
      dbPath: path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    },
    {
      name: "vscode",
      dbPath: path.join(home, ".config/Code/User/globalStorage/state.vscdb"),
    },
  ];
};

const parseEditorRecentWorkspaces = (raw: string): EditorWorkspace[] => {
  try {
    const data = JSON.parse(raw);
    const entries: Array<{
      folderUri?: string;
      fileUri?: string;
    }> = data.entries ?? [];

    return entries
      .map((entry) => entry.folderUri || entry.fileUri)
      .filter((value): value is string => Boolean(value))
      .map((workspacePath) => ({ path: workspacePath }));
  } catch {
    return [];
  }
};

const parseEditorTrackedRepos = (raw: string): EditorTrackedRepo[] => {
  try {
    const data = JSON.parse(raw) as Record<
      string,
      { localPath?: string; lastAccessed?: number }
    >;

    return Object.values(data)
      .filter((value) => value.localPath)
      .map((value) => ({
        path: value.localPath!,
        lastAccessed: value.lastAccessed,
      }))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  } catch {
    return [];
  }
};

const collectFromEditors = async (
  candidates: Map<string, ProjectCandidate>,
): Promise<number> => {
  let count = 0;
  const { Database } = await import("bun:sqlite");

  for (const config of getEditorConfigs()) {
    if (!(await fileExists(config.dbPath))) continue;

    let db: SqliteDatabase | null = null;
    try {
      // Read the live DB directly via an immutable URI: editors hold a WAL
      // lock on state.vscdb while running; immutable skips locking.
      const uri = `${pathToFileURL(config.dbPath).href}?immutable=1`;
      db = new Database(uri, { readonly: true }) as SqliteDatabase;

      const getKey = (key: string): string | null => {
        const row = db!
          .query("SELECT value FROM ItemTable WHERE key = ?")
          .get(key) as { value: Buffer | string } | undefined;
        if (!row) return null;
        return typeof row.value === "string"
          ? row.value
          : Buffer.from(row.value).toString("utf-8");
      };

      const recentRaw = getKey("history.recentlyOpenedPathsList");
      const recentWorkspaces = recentRaw
        ? parseEditorRecentWorkspaces(recentRaw)
        : [];
      for (const workspace of recentWorkspaces) {
        addCandidate(candidates, workspace.path, `${config.name}-recent`, 6);
        count += 1;
      }

      const trackerRaw = getKey("repositoryTracker.paths");
      const trackedRepos = trackerRaw
        ? parseEditorTrackedRepos(trackerRaw)
        : [];
      for (const repo of trackedRepos) {
        const lastAccessed = repo.lastAccessed;
        const age = lastAccessed ? daysAgo(lastAccessed) : null;
        const weight = age === null ? 4 : age <= 7 ? 8 : age <= 30 ? 6 : 3;
        addCandidate(
          candidates,
          repo.path,
          `${config.name}-repo-tracker`,
          weight,
          lastAccessed ? { editorLastAccessed: lastAccessed } : undefined,
        );
        count += 1;
      }
    } catch (error) {
      log(`Failed to read ${config.name} editor state:`, error);
    } finally {
      db?.close();
    }
  }

  return count;
};

// ---------------------------------------------------------------------------
// Source 5: Shell history
// ---------------------------------------------------------------------------

const getHistoryPaths = (): string[] => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [
      path.join(
        appData,
        "Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt",
      ),
      path.join(home, ".bash_history"),
    ];
  }

  return [path.join(home, ".zsh_history"), path.join(home, ".bash_history")];
};

const SENSITIVE_COMMAND_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /cat\s+.*\.env\b/i,
  /source\s+.*\.env\b/i,
  /curl.*-H.*Authorization/i,
  /\w+:\/\/[^/\s]*:[^/\s]*@/i,
];

const parseZshLine = (line: string): string | null => {
  if (line.startsWith(": ")) {
    const semicolonIdx = line.indexOf(";");
    if (semicolonIdx !== -1) {
      return line.slice(semicolonIdx + 1).trim();
    }
  }
  return line.trim();
};

const extractCdPath = (line: string): string | null => {
  const cdMatch = line.match(/^\s*cd\s+(.+)$/);
  if (!cdMatch) return null;

  const cdPathMatch = cdMatch[1]
    .trim()
    .match(/^(?:"([^"]+)"|'([^']+)'|([^\s&|;><]+))/);
  const cdPath = (
    cdPathMatch?.[1] ||
    cdPathMatch?.[2] ||
    cdPathMatch?.[3] ||
    ""
  ).trim();

  if (!cdPath || cdPath === "-" || cdPath === "." || cdPath === "..") {
    return null;
  }

  const expanded = cdPath.startsWith("~")
    ? path.join(os.homedir(), cdPath.slice(1))
    : cdPath;

  return path.isAbsolute(expanded) ? expanded : null;
};

const collectFromShellHistory = async (
  candidates: Map<string, ProjectCandidate>,
): Promise<number> => {
  let count = 0;

  for (const historyPath of getHistoryPaths()) {
    try {
      const content = await fs.readFile(historyPath, "utf-8");
      for (const rawLine of content.split("\n")) {
        const line = parseZshLine(rawLine);
        if (!line) continue;
        if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(line))) {
          continue;
        }

        const cdPath = extractCdPath(line);
        if (!cdPath) continue;
        addCandidate(candidates, cdPath, "shell-cd", 1);
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
};

// ---------------------------------------------------------------------------
// Source 6: Common dev roots
// ---------------------------------------------------------------------------

const shouldSkipScanDir = (name: string): boolean =>
  name.startsWith(".") ||
  [
    "node_modules",
    "Library",
    "Applications",
    "Downloads",
    "Desktop",
    "Documents",
    "Pictures",
    "Movies",
    "Music",
  ].includes(name);

const collectFromCommonDevRoots = async (
  candidates: Map<string, ProjectCandidate>,
): Promise<number> => {
  const home = os.homedir();
  const roots = COMMON_DEV_ROOT_NAMES.map((name) => path.join(home, name));
  let visitedDirs = 0;
  let reposFound = 0;

  for (const root of roots) {
    if (!(await fileExists(root))) continue;

    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      if (visitedDirs >= DEV_ROOT_SCAN_MAX_DIRS) return reposFound;
      if (reposFound >= DEV_ROOT_SCAN_MAX_REPOS) return reposFound;

      const current = queue.shift()!;
      visitedDirs += 1;

      if (await fileExists(path.join(current.dir, ".git"))) {
        addCandidate(candidates, current.dir, "dev-root-scan", 2);
        reposFound += 1;
        continue;
      }

      if (current.depth >= DEV_ROOT_SCAN_MAX_DEPTH) continue;

      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipScanDir(entry.name)) continue;
        queue.push({
          dir: path.join(current.dir, entry.name),
          depth: current.depth + 1,
        });
      }
    }
  }

  return reposFound;
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const resolveCandidates = async (
  candidates: ProjectCandidate[],
): Promise<ResolvedProjectCandidate[]> => {
  const resolved = new Map<string, ResolvedProjectCandidate>();

  for (let i = 0; i < candidates.length; i += MAX_VALIDATION_BATCH_SIZE) {
    const batch = candidates.slice(i, i + MAX_VALIDATION_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (candidate) => {
        const root = await resolveGitRoot(candidate.path);
        return root ? { candidate, root } : null;
      }),
    );

    for (const result of batchResults) {
      if (!result) continue;
      const key = candidateKey(result.root);
      const existing = resolved.get(key) ?? {
        path: result.root,
        sources: new Map<string, number>(),
      };

      for (const [source, weight] of result.candidate.sources.entries()) {
        existing.sources.set(
          source,
          (existing.sources.get(source) ?? 0) + weight,
        );
      }

      if (
        result.candidate.editorLastAccessed &&
        (!existing.editorLastAccessed ||
          result.candidate.editorLastAccessed > existing.editorLastAccessed)
      ) {
        existing.editorLastAccessed = result.candidate.editorLastAccessed;
      }

      resolved.set(key, existing);
    }
  }

  return Array.from(resolved.values());
};

const scoreProject = async (
  project: ResolvedProjectCandidate,
  globalIdentity: GitIdentity,
): Promise<ScoredProject | null> => {
  const lastActivity = await getGitRepoActivity(project.path);
  if (!lastActivity) return null;

  const authored = await hasRecentAuthoredCommit(project.path, globalIdentity);
  const manifestCount = await countProjectManifests(project.path);
  const age = daysAgo(lastActivity);
  const editorAge = project.editorLastAccessed
    ? daysAgo(project.editorLastAccessed)
    : null;

  let score = 0;
  for (const weight of project.sources.values()) score += weight;

  if (age <= 3) score += 8;
  else if (age <= 14) score += 5;
  else if (age <= RECENCY_DAYS) score += 3;

  if (editorAge !== null) {
    if (editorAge <= 7) score += 4;
    else if (editorAge <= RECENCY_DAYS) score += 2;
  }

  if (authored === true) score += 6;
  else if (authored === false) score -= 2;

  if (manifestCount > 0) {
    score += Math.min(4, manifestCount);
  }

  if (score < MIN_PROJECT_SCORE) return null;

  return {
    name: path.basename(project.path),
    path: project.path,
    lastActivity,
    score,
    sourceSummary: sourceList(project.sources),
  };
};

// ---------------------------------------------------------------------------
// Tech Detection (languages + frameworks per project)
// ---------------------------------------------------------------------------

// Framework labels keyed by their npm dependency name. Ordered so the most
// specific match wins when several are present (Next.js before React, etc.).
const PACKAGE_FRAMEWORKS: { dep: string; label: string }[] = [
  { dep: "next", label: "Next.js" },
  { dep: "react-native", label: "React Native" },
  { dep: "expo", label: "Expo" },
  { dep: "@remix-run/react", label: "Remix" },
  { dep: "@sveltejs/kit", label: "SvelteKit" },
  { dep: "nuxt", label: "Nuxt" },
  { dep: "astro", label: "Astro" },
  { dep: "@angular/core", label: "Angular" },
  { dep: "svelte", label: "Svelte" },
  { dep: "vue", label: "Vue" },
  { dep: "solid-js", label: "Solid" },
  { dep: "react", label: "React" },
  { dep: "electron", label: "Electron" },
  { dep: "@tauri-apps/api", label: "Tauri" },
  { dep: "convex", label: "Convex" },
  { dep: "@nestjs/core", label: "NestJS" },
  { dep: "fastify", label: "Fastify" },
  { dep: "express", label: "Express" },
  { dep: "vite", label: "Vite" },
];

const PYTHON_FRAMEWORKS: { needle: string; label: string }[] = [
  { needle: "django", label: "Django" },
  { needle: "flask", label: "Flask" },
  { needle: "fastapi", label: "FastAPI" },
];

const readJsonSafe = async (
  filePath: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    if (raw.length > 512 * 1024) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};

// Child dirs that never hold the "real" project manifest when scanning a
// monorepo/app-in-subdir layout.
const TECH_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "vendor",
  "app-store-screenshots",
]);

/** Detect languages/frameworks from the manifests directly inside `dir`. */
const detectTechAtDir = async (
  dir: string,
  entries: string[],
): Promise<Set<string>> => {
  const has = (name: string) => entries.includes(name);
  const tech = new Set<string>();

  if (has("package.json")) {
    const pkg = await readJsonSafe(path.join(dir, "package.json"));
    const depNames = new Set([
      ...Object.keys(
        (pkg?.dependencies as Record<string, unknown> | undefined) ?? {},
      ),
      ...Object.keys(
        (pkg?.devDependencies as Record<string, unknown> | undefined) ?? {},
      ),
    ]);
    tech.add(
      has("tsconfig.json") || depNames.has("typescript")
        ? "TypeScript"
        : "JavaScript",
    );
    for (const { dep, label } of PACKAGE_FRAMEWORKS) {
      if (depNames.has(dep)) tech.add(label);
    }
  }

  if (has("Cargo.toml")) tech.add("Rust");
  if (has("src-tauri")) tech.add("Tauri");
  if (has("go.mod")) tech.add("Go");

  if (has("pyproject.toml") || has("requirements.txt")) {
    tech.add("Python");
    if (has("requirements.txt")) {
      try {
        const reqs = (
          await fs.readFile(path.join(dir, "requirements.txt"), "utf-8")
        ).toLowerCase();
        for (const { needle, label } of PYTHON_FRAMEWORKS) {
          if (reqs.includes(needle)) tech.add(label);
        }
      } catch {
        // requirements unreadable — language is still recorded.
      }
    }
  }

  if (
    has("Package.swift") ||
    entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))
  ) {
    tech.add("Swift");
  }

  if (has("Gemfile")) {
    tech.add("Ruby");
    try {
      const gemfile = (
        await fs.readFile(path.join(dir, "Gemfile"), "utf-8")
      ).toLowerCase();
      if (gemfile.includes("rails")) tech.add("Rails");
    } catch {
      // Gemfile unreadable — language is still recorded.
    }
  }

  if (has("composer.json")) tech.add("PHP");
  if (has("build.gradle.kts")) tech.add("Kotlin");
  else if (has("pom.xml") || has("build.gradle")) tech.add("Java");

  return tech;
};

/**
 * Detect a project's languages + frameworks from its manifest files. Bounded
 * and cheap (a readdir + a few small file reads), cross-platform. Reads
 * manifests rather than scanning every source file. When the repo root has no
 * manifest (monorepo / app-in-subdir like `mobile/`), falls back to a bounded
 * one-level scan of immediate child directories.
 */
const detectProjectTech = async (projectPath: string): Promise<string[]> => {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(projectPath);
  } catch {
    return [];
  }

  const tech = await detectTechAtDir(projectPath, entries);
  if (tech.size > 0) return Array.from(tech);

  const childDirs = entries
    .filter((e) => !e.startsWith(".") && !TECH_SCAN_SKIP_DIRS.has(e))
    .slice(0, 12);
  for (const child of childDirs) {
    const childPath = path.join(projectPath, child);
    try {
      const childStat = await fs.stat(childPath);
      if (!childStat.isDirectory()) continue;
      const childEntries = await fs.readdir(childPath);
      for (const t of await detectTechAtDir(childPath, childEntries)) {
        tech.add(t);
      }
    } catch {
      continue;
    }
    if (tech.size >= 6) break;
  }

  return Array.from(tech);
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

export const collectDevProjects = async (): Promise<DevProject[]> => {
  log("Starting dev projects discovery...");

  const candidates = new Map<string, ProjectCandidate>();

  const [
    identity,
    spotlightPaths,
    ghDesktopPaths,
    jetbrainsPaths,
    editorCount,
    shellCount,
    devRootCount,
  ] = await Promise.all([
    readGlobalGitIdentity(),
    collectFromSpotlight(),
    collectFromGitHubDesktop(),
    collectFromJetBrains(),
    collectFromEditors(candidates).catch((error) => {
      log("Editor state collection failed:", error);
      return 0;
    }),
    collectFromShellHistory(candidates).catch((error) => {
      log("Shell history project collection failed:", error);
      return 0;
    }),
    collectFromCommonDevRoots(candidates).catch((error) => {
      log("Dev root scan failed:", error);
      return 0;
    }),
  ]);

  for (const projectPath of spotlightPaths) {
    addCandidate(candidates, projectPath, "spotlight", 2);
  }
  for (const projectPath of ghDesktopPaths) {
    addCandidate(candidates, projectPath, "github-desktop", 4);
  }
  for (const projectPath of jetbrainsPaths) {
    addCandidate(candidates, projectPath, "jetbrains", 5);
  }

  log(
    [
      `Candidates: spotlight=${spotlightPaths.length}`,
      `github-desktop=${ghDesktopPaths.length}`,
      `jetbrains=${jetbrainsPaths.length}`,
      `editor=${editorCount}`,
      `shell-cd=${shellCount}`,
      `dev-root=${devRootCount}`,
    ].join(", "),
  );
  if (identity.name || identity.email) {
    log(`Git identity: ${identity.name || "?"} <${identity.email || "?"}>`);
  }

  const candidatePaths = Array.from(candidates.values()).slice(
    0,
    MAX_CANDIDATE_PATHS,
  );
  log(`${candidatePaths.length} unique candidate paths`);

  const resolved = await resolveCandidates(candidatePaths);
  log(`${resolved.length} git repos resolved from candidates`);

  const scored: ScoredProject[] = [];
  for (let i = 0; i < resolved.length; i += MAX_VALIDATION_BATCH_SIZE) {
    const batch = resolved.slice(i, i + MAX_VALIDATION_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((project) => scoreProject(project, identity)),
    );
    for (const result of batchResults) {
      if (result) scored.push(result);
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.lastActivity - a.lastActivity ||
      a.path.localeCompare(b.path),
  );

  const limited = await Promise.all(
    scored.slice(0, MAX_RESULTS).map(async (project) => ({
      name: project.name,
      path: project.path,
      lastActivity: project.lastActivity,
      tech: await detectProjectTech(project.path),
    })),
  );

  log(
    `Found ${limited.length} active projects above score ${MIN_PROJECT_SCORE}`,
  );
  if (scored.length > 0) {
    log(
      "Top projects:",
      scored
        .slice(0, 8)
        .map(
          (project) =>
            `${project.name} score=${project.score} sources=${project.sourceSummary.join("+")}`,
        )
        .join("; "),
    );
  }

  return limited;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format dev projects for LLM synthesis.
 *
 * Projects are already sorted by confidence and activity from collection.
 * We cap at 8 for synthesis — enough to show active work, not so many that
 * stale projects dilute the signal.
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
          const age = daysAgo(p.lastActivity);
          const recency =
            age === 0 ? "today" : age === 1 ? "yesterday" : `${age}d ago`;
          const tech =
            p.tech && p.tech.length > 0 ? ` — ${p.tech.join(", ")}` : "";
          return `- ${p.name} (${p.path}) (${recency})${tech}`;
        })
        .join("\n"),
  );

  return sections.join("\n");
};
