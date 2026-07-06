/**
 * System Signals Collector
 *
 * Gathers behavioral data:
 * - Screen Time / app usage (knowledgeC.db on macOS, ActivitiesCache.db on Windows)
 * - Dock pins (macOS) / Taskbar pins (Windows)
 * - OS account identity
 *
 * NO theme/accessibility/appearance signals — only behavioral data.
 */

import path from "path";
import os from "os";
import { exec } from "child_process";
import { promises as fs } from "fs";
import { pathToFileURL } from "node:url";
import type {
  SystemSignals,
  DockPin,
  AppUsageSummary,
  UserIdentitySignal,
  DeviceSignals,
} from "./discovery-types.js";

const log = (...args: unknown[]) => console.error("[system-signals]", ...args);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const execAsync = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// SQLite Helper
// ---------------------------------------------------------------------------

type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  const { Database } = await import("bun:sqlite");
  // Read the live DB directly via an immutable URI: skips locking and reads
  // the main file without its WAL sidecars. Best-effort one-time snapshot.
  const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
  return new Database(uri, { readonly: true }) as SqliteDatabase;
};

// ---------------------------------------------------------------------------
// User Identity
// ---------------------------------------------------------------------------

async function collectUserIdentity(): Promise<UserIdentitySignal | null> {
  const identity: UserIdentitySignal = {};

  try {
    const info = os.userInfo();
    if (info.username) identity.username = info.username;
    if (info.homedir) identity.homeDirectory = info.homedir;
  } catch {
    identity.homeDirectory = os.homedir();
  }

  try {
    if (os.platform() === "darwin") {
      const fullName = await execAsync("id -F");
      if (fullName) identity.fullName = fullName;
    } else if (os.platform() === "win32") {
      const fullName = await execAsync("powershell -NoProfile -Command \"[Environment]::UserName\"");
      if (fullName) identity.fullName = fullName;
    }
  } catch {
    // OS account display names are best-effort evidence, not required.
  }

  return identity.username || identity.fullName || identity.homeDirectory
    ? identity
    : null;
}

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
    const message = getErrorMessage(error);
    if (message.includes("invalid object in plist")) {
      log("Dock plist could not be parsed, skipping dock pins");
    } else {
      log("Failed to read dock pins:", message);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// App Usage
// ---------------------------------------------------------------------------

async function collectAppUsageMacOS(): Promise<AppUsageSummary[]> {
  try {
    const sourceDb = path.join(
      os.homedir(),
      "Library/Application Support/Knowledge/knowledgeC.db"
    );

    let db: SqliteDatabase;
    try {
      db = await openDatabase(sourceDb);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        log("knowledgeC.db access denied - grant Full Disk Access");
        return [];
      }
      throw error;
    }

    const query = `
      SELECT
        ZVALUESTRING as app,
        SUM(ZENDDATE - ZSTARTDATE) as total_seconds
      FROM ZOBJECT
      WHERE ZSTREAMNAME = '/app/usage'
        AND ZVALUESTRING IS NOT NULL
        AND ZVALUESTRING != ''
        AND ZSTARTDATE > (strftime('%s', 'now') - 978307200 - 604800)
      GROUP BY ZVALUESTRING
      ORDER BY total_seconds DESC
      LIMIT 30
    `;

    const rows = db.prepare(query).all() as Array<{ app: string; total_seconds: number }>;
    db.close();

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

async function collectAppUsageWindows(): Promise<AppUsageSummary[]> {
  try {
    const cdpBase = path.join(
      os.homedir(),
      "AppData/Local/ConnectedDevicesPlatform"
    );

    // Find ActivitiesCache.db (check all subdirs in parallel)
    const dirs = await fs.readdir(cdpBase);
    const dbResults = await Promise.all(
      dirs.map(async (dir) => {
        const candidate = path.join(cdpBase, dir, "ActivitiesCache.db");
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          return null;
        }
      })
    );
    const dbPath = dbResults.find((p) => p !== null) ?? null;

    if (!dbPath) {
      log("ActivitiesCache.db not found");
      return [];
    }

    const db = await openDatabase(dbPath);

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

async function collectAppUsage(): Promise<AppUsageSummary[]> {
  if (os.platform() === "darwin") {
    return collectAppUsageMacOS();
  } else if (os.platform() === "win32") {
    return collectAppUsageWindows();
  }
  return [];
}

// ---------------------------------------------------------------------------
// Device / Hardware
// ---------------------------------------------------------------------------

/**
 * Device + hardware profile. Most fields come from Node's `os` module (instant,
 * cross-platform); OS marketing version and hardware model are enriched per
 * platform best-effort.
 */
async function collectDevice(): Promise<DeviceSignals> {
  const platform = os.platform();
  const cpus = os.cpus();
  const cpu = cpus[0]?.model?.trim() || undefined;
  const cpuCores = cpus.length || undefined;
  const totalMem = os.totalmem();
  const memoryGB = totalMem ? Math.round(totalMem / 1024 ** 3) : undefined;
  const arch =
    process.arch === "arm64"
      ? platform === "darwin"
        ? "Apple Silicon (arm64)"
        : "ARM64"
      : process.arch;

  let osLabel = `${platform} ${os.release()}`;
  let model: string | undefined;

  if (platform === "darwin") {
    try {
      const product = (await execAsync("sw_vers -productVersion")).trim();
      if (product) osLabel = `macOS ${product}`;
    } catch {
      // Keep the os.release() fallback.
    }
    try {
      model = (await execAsync("sysctl -n hw.model")).trim() || undefined;
    } catch {
      // Model is optional.
    }
  } else if (platform === "win32") {
    try {
      const caption = (
        await execAsync(
          'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption"'
        )
      ).trim();
      if (caption) osLabel = caption;
    } catch {
      // Keep the os.release() fallback.
    }
    try {
      const winModel = (
        await execAsync(
          'powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystem).Model"'
        )
      ).trim();
      model = winModel || undefined;
    } catch {
      // Model is optional.
    }
  }

  return { os: osLabel, arch, model, cpu, cpuCores, memoryGB };
}

// ---------------------------------------------------------------------------
// Main Collector
// ---------------------------------------------------------------------------

export async function collectSystemSignals(): Promise<SystemSignals> {
  const [userIdentity, dockPins, appUsage, device] = await Promise.all([
    withTimeout(collectUserIdentity(), 2000, null),
    withTimeout(collectDockPins(), 3000, []),
    withTimeout(collectAppUsage(), 10000, []),
    withTimeout(collectDevice(), 4000, null),
  ]);

  return { userIdentity, dockPins, appUsage, device };
}

// ---------------------------------------------------------------------------
// Format for Synthesis
// ---------------------------------------------------------------------------

export function formatSystemSignalsForSynthesis(data: SystemSignals): string {
  const sections: string[] = [];

  if (data.userIdentity) {
    const identitySection = ["### OS Account Identity"];
    if (data.userIdentity.fullName) {
      identitySection.push(`Full Name: ${data.userIdentity.fullName}`);
    }
    if (data.userIdentity.username) {
      identitySection.push(`Username: ${data.userIdentity.username}`);
    }
    if (data.userIdentity.homeDirectory) {
      identitySection.push(`Home Directory: ${data.userIdentity.homeDirectory}`);
    }
    sections.push(identitySection.join("\n"));
  }

  // Device & Hardware
  if (data.device) {
    const d = data.device;
    const deviceLines = ["### Device"];
    const head = [d.model, d.os, d.arch].filter(Boolean);
    if (head.length > 0) deviceLines.push(head.join(" · "));
    const specs: string[] = [];
    if (d.cpu) specs.push(d.cpu);
    if (d.cpuCores) specs.push(`${d.cpuCores} cores`);
    if (d.memoryGB) specs.push(`${d.memoryGB} GB RAM`);
    if (specs.length > 0) deviceLines.push(specs.join(", "));
    if (deviceLines.length > 1) sections.push(deviceLines.join("\n"));
  }

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

  if (sections.length === 0) {
    return "";
  }

  return `## System Signals\n${sections.join("\n\n")}`;
}
