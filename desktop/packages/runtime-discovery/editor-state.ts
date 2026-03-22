/**
 * Editor State Discovery
 *
 * Reads VS Code and Cursor state databases (state.vscdb) to extract:
 * - Recently opened workspaces/files
 * - Repository tracker (GitHub repos → local paths with timestamps)
 *
 * Both editors use the same SQLite key-value format.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";

const log = (...args: unknown[]) => console.log("[editor-state]", ...args);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditorWorkspace = {
  path: string;
  label?: string;
  remote?: string; // e.g. "wsl+Ubuntu-24.04"
};

export type TrackedRepo = {
  remote: string; // e.g. "github.com/user/repo"
  localPath: string;
  lastAccessed: number; // ms since epoch
};

export type EditorStateSignals = {
  editor: string; // "cursor" | "vscode"
  recentWorkspaces: EditorWorkspace[];
  trackedRepos: TrackedRepo[];
};

// ---------------------------------------------------------------------------
// Database Paths
// ---------------------------------------------------------------------------

type EditorConfig = {
  name: string;
  dbPath: string;
};

const getEditorConfigs = (): EditorConfig[] => {
  const home = os.homedir();
  const platform = process.platform;

  const configs: EditorConfig[] = [];

  if (platform === "win32") {
    configs.push(
      { name: "cursor", dbPath: path.join(home, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb") },
      { name: "vscode", dbPath: path.join(home, "AppData/Roaming/Code/User/globalStorage/state.vscdb") },
    );
  } else if (platform === "darwin") {
    configs.push(
      { name: "cursor", dbPath: path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb") },
      { name: "vscode", dbPath: path.join(home, "Library/Application Support/Code/User/globalStorage/state.vscdb") },
    );
  } else {
    configs.push(
      { name: "cursor", dbPath: path.join(home, ".config/Cursor/User/globalStorage/state.vscdb") },
      { name: "vscode", dbPath: path.join(home, ".config/Code/User/globalStorage/state.vscdb") },
    );
  }

  return configs;
};

// ---------------------------------------------------------------------------
// SQLite Helper (same pattern as browser-data.ts)
// ---------------------------------------------------------------------------

type SqliteDatabase = {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
};

const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  const { default: Database } = await import("better-sqlite3");
  return new Database(dbPath, { readonly: true }) as SqliteDatabase;
};

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const parseRecentWorkspaces = (raw: string): EditorWorkspace[] => {
  try {
    const data = JSON.parse(raw);
    const entries: Array<{ folderUri?: string; fileUri?: string; workspace?: unknown; label?: string; remoteAuthority?: string }> = data.entries ?? [];

    const workspaces: EditorWorkspace[] = [];

    for (const entry of entries) {
      const uri = entry.folderUri || entry.fileUri;
      if (!uri) continue;

      // Decode URI to a readable path
      let decoded: string;
      try {
        decoded = decodeURIComponent(uri)
          .replace(/^file:\/\/\//, "")
          .replace(/^vscode-remote:\/\/[^/]+/, "");
      } catch {
        continue;
      }

      // Skip noise: extension paths, debugger paths, single files in system dirs
      if (decoded.includes(".vscode/extensions")) continue;
      if (decoded.includes("debugpy")) continue;

      workspaces.push({
        path: decoded,
        label: entry.label,
        remote: entry.remoteAuthority,
      });
    }

    return workspaces;
  } catch {
    return [];
  }
};

const parseTrackedRepos = (raw: string): TrackedRepo[] => {
  try {
    const data = JSON.parse(raw) as Record<string, { localPath: string; lastAccessed: number }>;
    const repos: TrackedRepo[] = [];

    for (const [remote, info] of Object.entries(data)) {
      let localPath: string;
      try {
        localPath = decodeURIComponent(info.localPath).replace(/^file:\/\/\//, "");
      } catch {
        continue;
      }

      repos.push({
        remote,
        localPath,
        lastAccessed: info.lastAccessed,
      });
    }

    // Sort by most recently accessed
    repos.sort((a, b) => b.lastAccessed - a.lastAccessed);

    return repos;
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

export const collectEditorState = async (): Promise<EditorStateSignals | null> => {
  const configs = getEditorConfigs();

  for (const config of configs) {
    try {
      await fs.access(config.dbPath);
    } catch {
      continue;
    }

    log(`Found ${config.name} state database`);

    let db: SqliteDatabase | null = null;
    try {
      db = await openDatabase(config.dbPath);

      const getKey = (key: string): string | null => {
        const row = db!.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value: Buffer | string } | undefined;
        if (!row) return null;
        return typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf-8");
      };

      const recentRaw = getKey("history.recentlyOpenedPathsList");
      const recentWorkspaces = recentRaw ? parseRecentWorkspaces(recentRaw) : [];

      const trackerRaw = getKey("repositoryTracker.paths");
      const trackedRepos = trackerRaw ? parseTrackedRepos(trackerRaw) : [];

      log(`Collected from ${config.name}: ${recentWorkspaces.length} workspaces, ${trackedRepos.length} tracked repos`);

      return {
        editor: config.name,
        recentWorkspaces,
        trackedRepos,
      };
    } catch (error) {
      log(`Failed to read ${config.name} state:`, error);
    } finally {
      db?.close?.();
    }
  }

  log("No editor state database found");
  return null;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const formatEditorStateForSynthesis = (signals: EditorStateSignals): string => {
  const sections: string[] = [`## Editor State (${signals.editor})`];

  if (signals.recentWorkspaces.length > 0) {
    sections.push("\n### Recently Opened Workspaces");
    sections.push(
      signals.recentWorkspaces
        .slice(0, 15)
        .map((w) => {
          const remote = w.remote ? ` [${w.remote}]` : "";
          return `- ${w.path}${remote}`;
        })
        .join("\n")
    );
  }

  if (signals.trackedRepos.length > 0) {
    sections.push("\n### Git Repositories");
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = signals.trackedRepos.filter((r) => r.lastAccessed >= thirtyDaysAgo);
    const toShow = recent.length > 0 ? recent : signals.trackedRepos.slice(0, 10);

    sections.push(
      toShow
        .slice(0, 15)
        .map((r) => {
          const daysAgo = Math.floor((Date.now() - r.lastAccessed) / (24 * 60 * 60 * 1000));
          const recency = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
          return `- ${r.remote} → ${r.localPath} (${recency})`;
        })
        .join("\n")
    );
  }

  return sections.join("\n");
};
