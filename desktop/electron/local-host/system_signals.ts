/**
 * System Signals Collector
 *
 * Gathers behavioral data:
 * - Screen Time / app usage (knowledgeC.db on macOS, ActivitiesCache.db on Windows)
 * - Dock pins (macOS)
 * - Filesystem signals (Downloads, Documents, Desktop)
 *
 * NO theme/accessibility/appearance signals — only behavioral data.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import type {
  SystemSignals,
  DockPin,
  AppUsageSummary,
  FilesystemSignals,
} from "./discovery_types.js";

const log = (...args: unknown[]) => console.log("[system-signals]", ...args);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const execAsync = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
};

// ---------------------------------------------------------------------------
// SQLite Helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dock Pins (macOS)
// ---------------------------------------------------------------------------

async function collectDockPins(): Promise<DockPin[]> {
  if (os.platform() !== "darwin") {
    return [];
  }

  try {
    const dockPlistPath = path.join(os.homedir(), "Library/Preferences/com.apple.dock.plist");
    const output = await execAsync(`plutil -convert json -o - "${dockPlistPath}"`);
    const plist = JSON.parse(output);

    const persistentApps = plist["persistent-apps"] || [];
    const pins: DockPin[] = [];

    for (const entry of persistentApps) {
      const tileData = entry["tile-data"];
      if (!tileData) continue;

      const name = tileData["file-label"];
      const fileData = tileData["file-data"];
      const urlString = fileData ? fileData["_CFURLString"] : undefined;

      if (name && urlString) {
        pins.push({ name, path: urlString });
      }
    }

    return pins;
  } catch (error) {
    log("Failed to read dock pins:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// App Usage
// ---------------------------------------------------------------------------

async function collectAppUsageMacOS(stellaHome: string): Promise<AppUsageSummary[]> {
  try {
    const sourceDb = path.join(
      os.homedir(),
      "Library/Application Support/Knowledge/knowledgeC.db"
    );

    // Copy to cache to avoid locking issues
    const cacheDir = path.join(stellaHome, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const cachedDb = path.join(cacheDir, "knowledgec.db");

    try {
      await fs.copyFile(sourceDb, cachedDb);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        log("knowledgeC.db access denied - grant Full Disk Access");
        return [];
      }
      throw error;
    }

    const db = await openDatabase(cachedDb);

    const query = `
      SELECT
        ZVALUESTRING as app,
        SUM(ZENDDATE - ZSTARTDATE) as total_seconds
      FROM ZOBJECT
      WHERE ZSTREAMNAME = '/app/usage'
        AND ZVALUESTRING IS NOT NULL
        AND ZVALUESTRING != ''
        AND ZSTARTDATE > (strftime('%s', 'now') - 604800)
      GROUP BY ZVALUESTRING
      ORDER BY total_seconds DESC
      LIMIT 30
    `;

    const rows = db.prepare(query).all() as Array<{ app: string; total_seconds: number }>;
    db.close();

    // Clean up cache
    await fs.unlink(cachedDb).catch(() => {});

    // Process results
    const appUsage: AppUsageSummary[] = rows.map((row) => {
      let appName = row.app;

      // Clean up app names
      if (appName.startsWith("com.apple.")) {
        appName = appName.replace("com.apple.", "");
      }

      // Extract last component of bundle IDs
      const parts = appName.split(".");
      if (parts.length > 1) {
        appName = parts[parts.length - 1];
      }

      // Capitalize first letter
      appName = appName.charAt(0).toUpperCase() + appName.slice(1);

      const durationMinutes = Math.round(row.total_seconds / 60);

      return {
        app: appName,
        durationMinutes,
      };
    });

    return appUsage.filter((a) => a.durationMinutes > 0);
  } catch (error) {
    log("Failed to read macOS app usage:", error);
    return [];
  }
}

async function collectAppUsageWindows(stellaHome: string): Promise<AppUsageSummary[]> {
  try {
    const cdpBase = path.join(
      os.homedir(),
      "AppData/Local/ConnectedDevicesPlatform"
    );

    // Find ActivitiesCache.db
    let dbPath: string | null = null;
    const dirs = await fs.readdir(cdpBase);

    for (const dir of dirs) {
      const candidate = path.join(cdpBase, dir, "ActivitiesCache.db");
      try {
        await fs.access(candidate);
        dbPath = candidate;
        break;
      } catch {
        continue;
      }
    }

    if (!dbPath) {
      log("ActivitiesCache.db not found");
      return [];
    }

    // Copy to cache
    const cacheDir = path.join(stellaHome, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const cachedDb = path.join(cacheDir, "activitiescache.db");
    await fs.copyFile(dbPath, cachedDb);

    const db = await openDatabase(cachedDb);

    let rows: Array<{ AppId: string; total_seconds: number }>;
    try {
      // Preferred query when ActiveDurationSeconds is available.
      const query = `
        SELECT
          AppId,
          SUM(COALESCE(ActiveDurationSeconds, 0)) as total_seconds
        FROM Activity
        WHERE LastModifiedTime > datetime('now', '-7 days')
        GROUP BY AppId
        ORDER BY total_seconds DESC
        LIMIT 30
      `;
      rows = db.prepare(query).all() as Array<{ AppId: string; total_seconds: number }>;
    } catch {
      // Fallback for schema variants where duration columns differ.
      const fallbackQuery = `
        SELECT
          AppId,
          COUNT(*) as total_seconds
        FROM Activity
        WHERE LastModifiedTime > datetime('now', '-7 days')
        GROUP BY AppId
        ORDER BY total_seconds DESC
        LIMIT 30
      `;
      rows = db.prepare(fallbackQuery).all() as Array<{ AppId: string; total_seconds: number }>;
    }
    db.close();

    // Clean up cache
    await fs.unlink(cachedDb).catch(() => {});

    // Process results
    const appUsage: AppUsageSummary[] = rows
      .map((row) => {
        let appName = row.AppId;

        // Try to parse as JSON
        try {
          const parsed = JSON.parse(appName);
          if (parsed.application) {
            appName = parsed.application;
          }
        } catch {
          // Not JSON, use as-is
        }

        // Clean up app names
        if (appName.startsWith("Microsoft.")) {
          appName = appName.replace("Microsoft.", "");
        }

        return {
          app: appName,
          durationMinutes: Math.round((row.total_seconds || 0) / 60),
        };
      })
      .filter((a) => a.durationMinutes > 0);

    return appUsage;
  } catch (error) {
    log("Failed to read Windows app usage:", error);
    return [];
  }
}

async function collectAppUsage(stellaHome: string): Promise<AppUsageSummary[]> {
  if (os.platform() === "darwin") {
    return collectAppUsageMacOS(stellaHome);
  } else if (os.platform() === "win32") {
    return collectAppUsageWindows(stellaHome);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Filesystem Signals
// ---------------------------------------------------------------------------

async function collectFilesystemSignals(): Promise<FilesystemSignals> {
  const result: FilesystemSignals = {
    downloadsExtensions: {},
    documentsFolders: [],
    desktopFileTypes: {},
  };

  // Downloads
  try {
    const downloadsPath = path.join(os.homedir(), "Downloads");
    const files = await fs.readdir(downloadsPath);
    const extensions: Record<string, number> = {};

    for (const file of files) {
      if (file.startsWith(".")) continue;

      const ext = path.extname(file).toLowerCase();
      if (ext) {
        extensions[ext] = (extensions[ext] || 0) + 1;
      }
    }

    // Sort by count and take top 15
    const sorted = Object.entries(extensions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    result.downloadsExtensions = Object.fromEntries(sorted);
  } catch (error) {
    log("Failed to read Downloads:", error);
  }

  // Documents
  try {
    const documentsPath = path.join(os.homedir(), "Documents");
    const entries = await fs.readdir(documentsPath);
    const folders: string[] = [];

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;

      const fullPath = path.join(documentsPath, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          folders.push(entry);
        }
      } catch {
        continue;
      }
    }

    result.documentsFolders = folders.slice(0, 20);
  } catch (error) {
    log("Failed to read Documents:", error);
  }

  // Desktop
  try {
    const desktopPath = path.join(os.homedir(), "Desktop");
    const files = await fs.readdir(desktopPath);
    const extensions: Record<string, number> = {};

    for (const file of files) {
      if (file.startsWith(".")) continue;

      const ext = path.extname(file).toLowerCase();
      if (ext) {
        extensions[ext] = (extensions[ext] || 0) + 1;
      }
    }

    // Sort by count and take top 15
    const sorted = Object.entries(extensions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    result.desktopFileTypes = Object.fromEntries(sorted);
  } catch (error) {
    log("Failed to read Desktop:", error);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main Collector
// ---------------------------------------------------------------------------

export async function collectSystemSignals(stellaHome: string): Promise<SystemSignals> {
  const [dockPins, appUsage, filesystem] = await Promise.all([
    withTimeout(collectDockPins(), 3000, []),
    withTimeout(collectAppUsage(stellaHome), 10000, []),
    withTimeout(collectFilesystemSignals(), 5000, {
      downloadsExtensions: {},
      documentsFolders: [],
      desktopFileTypes: {},
    }),
  ]);

  return { dockPins, appUsage, filesystem };
}

// ---------------------------------------------------------------------------
// Format for Synthesis
// ---------------------------------------------------------------------------

export function formatSystemSignalsForSynthesis(data: SystemSignals): string {
  const sections: string[] = [];

  // Dock/Pinned Apps
  if (data.dockPins.length > 0) {
    const dockSection = ["### Dock/Pinned Apps"];
    for (const pin of data.dockPins) {
      dockSection.push(`${pin.name} (${pin.path})`);
    }
    sections.push(dockSection.join("\n"));
  }

  // App Usage
  if (data.appUsage.length > 0) {
    const appSection = ["### App Usage (Screen Time)"];
    for (const app of data.appUsage) {
      const hours = Math.floor(app.durationMinutes / 60);
      const minutes = app.durationMinutes % 60;
      if (hours > 0) {
        appSection.push(`${app.app}: ${hours}h ${minutes}m`);
      } else {
        appSection.push(`${app.app}: ${minutes}m`);
      }
    }
    sections.push(appSection.join("\n"));
  }

  // Filesystem
  const hasDownloads = Object.keys(data.filesystem.downloadsExtensions).length > 0;
  const hasDocuments = data.filesystem.documentsFolders.length > 0;
  const hasDesktop = Object.keys(data.filesystem.desktopFileTypes).length > 0;

  if (hasDownloads || hasDocuments || hasDesktop) {
    const fsSection = ["### Filesystem"];

    if (hasDownloads) {
      fsSection.push("**Downloads** (by file type)");
      const items = Object.entries(data.filesystem.downloadsExtensions)
        .map(([ext, count]) => `${ext} (${count})`)
        .join(", ");
      fsSection.push(items);
    }

    if (hasDocuments) {
      fsSection.push("**Documents Folders**");
      fsSection.push(data.filesystem.documentsFolders.join(", "));
    }

    if (hasDesktop) {
      fsSection.push("**Desktop** (by file type)");
      const items = Object.entries(data.filesystem.desktopFileTypes)
        .map(([ext, count]) => `${ext} (${count})`)
        .join(", ");
      fsSection.push(items);
    }

    sections.push(fsSection.join("\n"));
  }

  if (sections.length === 0) {
    return "";
  }

  return `## System Signals\n${sections.join("\n\n")}`;
}
