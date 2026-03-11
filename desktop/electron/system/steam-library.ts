/**
 * Steam Library Discovery
 *
 * Reads Steam's local VDF/ACF files to extract:
 * - Game library with playtime and last-played dates
 * - Game names from app manifests (installed) + Steam Store API (uninstalled)
 *
 * Works on Windows, macOS, and Linux.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";

const log = (...args: unknown[]) => console.log("[steam-library]", ...args);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SteamGame = {
  appId: string;
  name: string;
  playtimeMinutes: number;
  lastPlayed: number; // unix timestamp (seconds)
};

export type SteamLibrarySignals = {
  username: string;
  games: SteamGame[];
};

// ---------------------------------------------------------------------------
// VDF Parser
// ---------------------------------------------------------------------------

/**
 * Minimal VDF/ACF parser. Valve's key-value text format:
 *   "key" "value"
 *   "key" { ...nested... }
 */
const parseVdf = (text: string): Record<string, unknown> => {
  let pos = 0;

  const skipWhitespace = () => {
    while (pos < text.length) {
      if (/\s/.test(text[pos])) { pos++; continue; }
      // Skip // comments
      if (text[pos] === "/" && text[pos + 1] === "/") {
        while (pos < text.length && text[pos] !== "\n") pos++;
        continue;
      }
      break;
    }
  };

  const readString = (): string => {
    if (text[pos] !== '"') throw new Error(`Expected " at ${pos}`);
    pos++;
    let result = "";
    while (pos < text.length && text[pos] !== '"') {
      if (text[pos] === "\\") {
        pos++;
        if (text[pos] === "n") result += "\n";
        else if (text[pos] === "t") result += "\t";
        else if (text[pos] === "\\") result += "\\";
        else result += text[pos];
      } else {
        result += text[pos];
      }
      pos++;
    }
    pos++; // closing quote
    return result;
  };

  const readObject = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    skipWhitespace();
    if (text[pos] === "{") pos++;

    while (pos < text.length) {
      skipWhitespace();
      if (pos >= text.length || text[pos] === "}") { pos++; break; }
      if (text[pos] !== '"') break;

      const key = readString();
      skipWhitespace();

      if (text[pos] === "{") {
        obj[key] = readObject();
      } else if (text[pos] === '"') {
        obj[key] = readString();
      }
    }
    return obj;
  };

  skipWhitespace();
  if (text[pos] === '"') {
    const key = readString();
    skipWhitespace();
    return { [key]: readObject() };
  }
  return readObject();
};

// ---------------------------------------------------------------------------
// Steam Path Detection
// ---------------------------------------------------------------------------

const getSteamPaths = (): string[] => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    return [
      "C:\\Program Files (x86)\\Steam",
      "C:\\Program Files\\Steam",
      path.join(home, "Steam"),
    ];
  } else if (platform === "darwin") {
    return [
      path.join(home, "Library/Application Support/Steam"),
    ];
  } else {
    return [
      path.join(home, ".steam/steam"),
      path.join(home, ".local/share/Steam"),
    ];
  }
};

const findSteamDir = async (): Promise<string | null> => {
  for (const p of getSteamPaths()) {
    try {
      await fs.access(p);
      return p;
    } catch { /* try next */ }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Data Extraction
// ---------------------------------------------------------------------------

/** Find the first user ID directory under userdata/ */
const findUserId = async (steamDir: string): Promise<string | null> => {
  const userDataDir = path.join(steamDir, "userdata");
  try {
    const entries = await fs.readdir(userDataDir);
    // Filter for numeric directories (Steam user IDs)
    const userIds = entries.filter((e) => /^\d+$/.test(e));
    return userIds[0] ?? null;
  } catch {
    return null;
  }
};

/** Get username from loginusers.vdf */
const getUsername = async (steamDir: string): Promise<string> => {
  try {
    const content = await fs.readFile(path.join(steamDir, "config", "loginusers.vdf"), "utf-8");
    const data = parseVdf(content);
    const users = (data.users ?? data.Users) as Record<string, Record<string, string>> | undefined;
    if (users) {
      for (const info of Object.values(users)) {
        if (info.PersonaName) return info.PersonaName;
        if (info.AccountName) return info.AccountName;
      }
    }
  } catch { /* fall through */ }
  return "Unknown";
};

/** Get library folder paths from libraryfolders.vdf */
const getLibraryPaths = async (steamDir: string): Promise<string[]> => {
  const paths: string[] = [steamDir];
  try {
    const content = await fs.readFile(
      path.join(steamDir, "config", "libraryfolders.vdf"),
      "utf-8",
    );
    const data = parseVdf(content);
    const folders = (data.libraryfolders ?? data.LibraryFolders) as Record<string, unknown> | undefined;
    if (folders) {
      for (const entry of Object.values(folders)) {
        if (typeof entry === "object" && entry !== null && "path" in entry) {
          const p = (entry as Record<string, string>).path;
          if (p && p !== steamDir) paths.push(p);
        }
      }
    }
  } catch { /* just use steamDir */ }
  return paths;
};

/** Scan appmanifest files across all library folders for game names */
const getGameNamesFromManifests = async (
  libraryPaths: string[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();

  for (const libPath of libraryPaths) {
    const steamapps = path.join(libPath, "steamapps");
    try {
      const files = await fs.readdir(steamapps);
      for (const file of files) {
        if (!file.startsWith("appmanifest_") || !file.endsWith(".acf")) continue;
        try {
          const content = await fs.readFile(path.join(steamapps, file), "utf-8");
          const data = parseVdf(content);
          const state = (data.AppState ?? data.appstate) as Record<string, string> | undefined;
          if (state?.appid && state?.name) {
            names.set(state.appid, state.name);
          }
        } catch { /* skip bad manifest */ }
      }
    } catch { /* dir doesn't exist */ }
  }

  return names;
};

/** Extract playtime data from localconfig.vdf */
const getPlaytimeData = async (
  steamDir: string,
  userId: string,
): Promise<Map<string, { playtimeMinutes: number; lastPlayed: number }>> => {
  const playtime = new Map<string, { playtimeMinutes: number; lastPlayed: number }>();

  try {
    const configPath = path.join(steamDir, "userdata", userId, "config", "localconfig.vdf");
    const content = await fs.readFile(configPath, "utf-8");

    // Extract per-app entries from the Software/Valve/Steam/apps section
    // Using regex for targeted extraction since the file can be large
    const appsIdx = content.indexOf('"apps"', content.indexOf('"Software"'));
    if (appsIdx === -1) return playtime;

    // Find the apps block
    let braceStart = content.indexOf("{", appsIdx);
    if (braceStart === -1) return playtime;
    let depth = 1;
    let pos = braceStart + 1;
    while (pos < content.length && depth > 0) {
      if (content[pos] === "{") depth++;
      else if (content[pos] === "}") depth--;
      pos++;
    }
    const appsBlock = content.substring(braceStart, pos);

    // Match individual app entries
    const appPattern = /"(\d+)"\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let match;
    while ((match = appPattern.exec(appsBlock)) !== null) {
      const appId = match[1];
      const body = match[2];
      const lastPlayedMatch = body.match(/"LastPlayed"\s+"(\d+)"/);
      const playtimeMatch = body.match(/"Playtime"\s+"(\d+)"/);

      if (lastPlayedMatch || playtimeMatch) {
        playtime.set(appId, {
          playtimeMinutes: playtimeMatch ? Number(playtimeMatch[1]) : 0,
          lastPlayed: lastPlayedMatch ? Number(lastPlayedMatch[1]) : 0,
        });
      }
    }
  } catch (error) {
    log("Failed to parse localconfig.vdf:", error);
  }

  return playtime;
};

/** Resolve game names for IDs missing from manifests via Steam Store API */
const resolveGameNames = async (
  appIds: string[],
  existingNames: Map<string, string>,
): Promise<void> => {
  // Only resolve up to 20 missing names to avoid hammering the API
  const missing = appIds.filter((id) => !existingNames.has(id)).slice(0, 20);
  if (missing.length === 0) return;

  log(`Resolving ${missing.length} game names from Steam API...`);

  const results = await Promise.allSettled(
    missing.map(async (appId) => {
      try {
        const res = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return;
        const json = (await res.json()) as Record<string, { success: boolean; data?: { name: string } }>;
        const entry = json[appId];
        if (entry?.success && entry.data?.name) {
          existingNames.set(appId, entry.data.name);
        }
      } catch { /* skip */ }
    }),
  );

  const resolved = results.filter((r) => r.status === "fulfilled").length;
  log(`Resolved ${resolved}/${missing.length} names`);
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

export const collectSteamLibrary = async (): Promise<SteamLibrarySignals | null> => {
  const steamDir = await findSteamDir();
  if (!steamDir) {
    log("Steam not found");
    return null;
  }
  log(`Found Steam at: ${steamDir}`);

  const userId = await findUserId(steamDir);
  if (!userId) {
    log("No Steam user data found");
    return null;
  }

  const [username, libraryPaths, playtimeData] = await Promise.all([
    getUsername(steamDir),
    getLibraryPaths(steamDir),
    getPlaytimeData(steamDir, userId),
  ]);

  const gameNames = await getGameNamesFromManifests(libraryPaths);

  // Get IDs that have playtime but no name, sorted by most recent
  const allIds = [...playtimeData.keys()]
    .sort((a, b) => (playtimeData.get(b)!.lastPlayed) - (playtimeData.get(a)!.lastPlayed));

  // Resolve missing names via API (top 20 most recent without names)
  await resolveGameNames(allIds, gameNames);

  // Build game list (only games we have names for)
  const games: SteamGame[] = [];
  for (const appId of allIds) {
    const name = gameNames.get(appId);
    if (!name) continue;

    // Skip redistributables, tools, etc.
    if (name.toLowerCase().includes("redistributable")) continue;
    if (name.toLowerCase().includes("proton ")) continue;

    const data = playtimeData.get(appId)!;
    games.push({
      appId,
      name,
      playtimeMinutes: data.playtimeMinutes,
      lastPlayed: data.lastPlayed,
    });
  }

  log(`Collected ${games.length} games for user "${username}"`);

  return { username, games };
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const formatSteamLibraryForSynthesis = (signals: SteamLibrarySignals): string => {
  if (signals.games.length === 0) return "";

  const sections: string[] = ["## Steam Library"];

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  // Recently played (last 90 days)
  const recent = signals.games
    .filter((g) => g.lastPlayed >= thirtyDaysAgo)
    .sort((a, b) => b.lastPlayed - a.lastPlayed);

  // Most played (by playtime, excluding recent)
  const recentIds = new Set(recent.map((g) => g.appId));
  const mostPlayed = signals.games
    .filter((g) => !recentIds.has(g.appId) && g.playtimeMinutes > 0)
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);

  const formatGame = (g: SteamGame): string => {
    const hours = (g.playtimeMinutes / 60).toFixed(0);
    const daysAgo = Math.floor((Date.now() / 1000 - g.lastPlayed) / (24 * 60 * 60));
    const recency =
      daysAgo === 0 ? "today" :
      daysAgo === 1 ? "yesterday" :
      daysAgo < 30 ? `${daysAgo}d ago` :
      `${Math.floor(daysAgo / 30)}mo ago`;
    return `- ${g.name} (${hours}h, ${recency})`;
  };

  if (recent.length > 0) {
    sections.push("\n### Recently Played");
    sections.push(recent.slice(0, 10).map(formatGame).join("\n"));
  }

  if (mostPlayed.length > 0) {
    sections.push("\n### Most Played");
    sections.push(mostPlayed.slice(0, 10).map(formatGame).join("\n"));
  }

  return sections.join("\n");
};
