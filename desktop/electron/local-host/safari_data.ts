/**
 * Safari Data Collection
 *
 * Reads Safari browser history and bookmarks on macOS.
 * Requires Full Disk Access for both History.db and Bookmarks.plist.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import type { SafariData, BookmarkEntry } from "./discovery_types.js";

const log = (...args: unknown[]) => console.log("[safari-data]", ...args);

// Declare Bun on globalThis for runtime detection
declare const globalThis: typeof global & { Bun?: unknown };

type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  if (typeof globalThis.Bun !== "undefined") {
    // @ts-expect-error bun:sqlite only available at runtime in Bun
    const { Database: BunDatabase } = await import("bun:sqlite");
    return new BunDatabase(dbPath, { readonly: true }) as SqliteDatabase;
  }
  const { default: Database } = await import("better-sqlite3");
  return new Database(dbPath, { readonly: true }) as SqliteDatabase;
};

const execAsync = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
};

// ---------------------------------------------------------------------------
// Safari History
// ---------------------------------------------------------------------------

/**
 * Collect Safari browsing history (last 7 days)
 * Requires Full Disk Access to read ~/Library/Safari/History.db
 */
export const collectSafariHistory = async (
  stellaHome: string
): Promise<{ domain: string; visits: number }[]> => {
  if (process.platform !== "darwin") {
    return [];
  }

  const historyPath = path.join(os.homedir(), "Library", "Safari", "History.db");

  try {
    // Check if the file exists
    await fs.access(historyPath);
  } catch {
    log("Safari History.db not found");
    return [];
  }

  let db: SqliteDatabase | null = null;
  let copyPath: string | null = null;

  try {
    // Copy the database to avoid lock issues
    const cacheDir = path.join(stellaHome, "cache");
    await fs.mkdir(cacheDir, { recursive: true });

    copyPath = path.join(cacheDir, "safari_history.db");
    await fs.copyFile(historyPath, copyPath);

    // Open the copy readonly
    db = await openDatabase(copyPath);

    // Query top domains by explicit visit rows in the last 7 days.
    // Safari history_visits.visit_time is CFAbsoluteTime (seconds since 2001-01-01).
    const query = `
      SELECT
        hi.domain AS domain,
        COUNT(*) AS visits
      FROM history_visits hv
      JOIN history_items hi ON hv.history_item = hi.id
      WHERE hi.domain IS NOT NULL
        AND hi.domain != ''
        AND hv.visit_time > ((strftime('%s', 'now') - 978307200) - 604800)
      GROUP BY hi.domain
      ORDER BY visits DESC
      LIMIT 30
    `;

    let rows: Array<{ domain: string; visits: number }> = [];
    try {
      rows = db.prepare(query).all() as Array<{ domain: string; visits: number }>;
    } catch (visitQueryError) {
      // Fallback for schema variants where history_visits is unavailable.
      const fallbackQuery = `
        SELECT domain, visit_count
        FROM history_items
        WHERE domain IS NOT NULL
          AND domain != ''
        ORDER BY visit_count DESC
        LIMIT 30
      `;
      const fallbackRows = db.prepare(fallbackQuery).all() as Array<{
        domain: string;
        visit_count: number;
      }>;
      rows = fallbackRows.map((row) => ({
        domain: row.domain,
        visits: row.visit_count,
      }));
      log("Using Safari history fallback query:", visitQueryError);
    }

    return rows.map((row) => ({
      domain: row.domain,
      visits: row.visits,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      log("Safari History access denied - grant Full Disk Access");
    } else {
      log("Error reading Safari history:", error);
    }
    return [];
  } finally {
    db?.close?.();
    if (copyPath) {
      fs.unlink(copyPath).catch(() => {});
    }
  }
};

// ---------------------------------------------------------------------------
// Safari Bookmarks
// ---------------------------------------------------------------------------

type BookmarkNode = {
  Title?: string;
  URLString?: string;
  URIDictionary?: { title?: string };
  Children?: BookmarkNode[];
  WebBookmarkType?: string;
};

type BookmarksPlist = {
  Children?: BookmarkNode[];
};

/**
 * Recursively walk bookmark tree and collect entries
 */
const walkBookmarks = (
  node: BookmarkNode,
  folder: string,
  result: BookmarkEntry[]
): void => {
  // Skip proxy entries (Reading List header, etc.)
  if (node.WebBookmarkType === "WebBookmarkTypeProxy") {
    return;
  }

  // Leaf node: has URL
  if (node.URLString) {
    const title = node.URIDictionary?.title || node.Title || "Untitled";
    result.push({
      title,
      url: node.URLString,
      folder: folder || undefined,
    });
    return;
  }

  // Folder node: has children
  if (node.Children) {
    const folderName = node.Title || folder;
    for (const child of node.Children) {
      walkBookmarks(child, folderName, result);
    }
  }
};

/**
 * Collect Safari bookmarks from Bookmarks.plist
 * Requires Full Disk Access to read ~/Library/Safari/Bookmarks.plist
 */
export const collectSafariBookmarks = async (): Promise<BookmarkEntry[]> => {
  if (process.platform !== "darwin") {
    return [];
  }

  const bookmarksPath = path.join(os.homedir(), "Library", "Safari", "Bookmarks.plist");

  try {
    // Convert binary plist to JSON
    const jsonOutput = await execAsync(
      `plutil -convert json -o - "${bookmarksPath}"`
    );

    const plist: BookmarksPlist = JSON.parse(jsonOutput);

    const result: BookmarkEntry[] = [];

    if (plist.Children) {
      for (const child of plist.Children) {
        walkBookmarks(child, "", result);
      }
    }

    // Limit to 200 entries
    return result.slice(0, 200);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      log("Safari Bookmarks access denied - grant Full Disk Access");
    } else {
      log("Error reading Safari bookmarks:", error);
    }
    return [];
  }
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

/**
 * Collect Safari history and bookmarks
 */
export const collectSafariData = async (
  stellaHome: string
): Promise<SafariData | null> => {
  if (process.platform !== "darwin") {
    return null;
  }

  log("Collecting Safari data...");

  const [history, bookmarks] = await Promise.all([
    collectSafariHistory(stellaHome),
    collectSafariBookmarks(),
  ]);

  if (history.length === 0 && bookmarks.length === 0) {
    log("No Safari data found");
    return null;
  }

  log("Safari data collected:", {
    history: history.length,
    bookmarks: bookmarks.length,
  });

  return { history, bookmarks };
};

// ---------------------------------------------------------------------------
// Formatting for Synthesis
// ---------------------------------------------------------------------------

/**
 * Format Safari data for LLM synthesis input
 */
export const formatSafariDataForSynthesis = (data: SafariData | null): string => {
  if (!data) return "";

  const sections: string[] = ["## Safari Data"];

  // Top domains (limit to 20)
  if (data.history.length > 0) {
    sections.push("\n### Top Domains");
    sections.push(
      data.history
        .slice(0, 20)
        .map((d) => `${d.domain} (${d.visits})`)
        .join("\n")
    );
  }

  // Bookmarks (limit to 15 folders with 8 entries each)
  if (data.bookmarks.length > 0) {
    sections.push("\n### Bookmarks");

    // Group bookmarks by folder
    const byFolder = new Map<string, BookmarkEntry[]>();
    for (const bookmark of data.bookmarks) {
      const folder = bookmark.folder || "Bookmarks";
      if (!byFolder.has(folder)) {
        byFolder.set(folder, []);
      }
      byFolder.get(folder)!.push(bookmark);
    }

    // Limit to 15 folders
    const folders = Array.from(byFolder.entries()).slice(0, 15);

    for (const [folder, entries] of folders) {
      sections.push(`\n**${folder}**`);

      // Limit to 8 entries per folder
      const limitedEntries = entries.slice(0, 8);

      for (const entry of limitedEntries) {
        // Extract domain from URL for compact display
        const domain = extractDomain(entry.url);
        sections.push(`- ${entry.title} (${domain})`);
      }
    }
  }

  return sections.join("\n");
};

/**
 * Extract domain from URL
 */
const extractDomain = (url: string): string => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
};
