/**
 * App Discovery
 *
 * Discovers apps with executable paths for Stella to launch.
 * Sources:
 * 1. Currently running apps (highest signal)
 * 2. Recently used apps (check data folder mtime)
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";

import type { DiscoveredApp, AppDiscoveryResult } from "./types.js";

const log = (...args: unknown[]) => console.error("[app-discovery]", ...args);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// How many days to consider an app "recently used"
const RECENCY_DAYS = 7;

// How many days back to look in UserAssist
const USERASSIST_DAYS = 7;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

const execAsync = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
};

/**
 * Clean app name for display
 */
const cleanAppName = (name: string): string => {
  return name
    .replace(/\.exe$/i, "")
    .replace(/\.app$/i, "")
    .trim();
};

// ---------------------------------------------------------------------------
// Windows: Running Apps (with visible windows only)
// ---------------------------------------------------------------------------

/**
 * Check if path is a system location (Windows)
 * These are Windows components, not user apps
 */
const isWindowsSystemPath = (exePath: string): boolean => {
  const lower = exePath.toLowerCase();
  return (
    lower.includes("\\windows\\systemapps\\") ||
    lower.includes("\\windows\\system32\\") ||
    lower.includes("\\windows\\syswow64\\")
  );
};

const discoverRunningAppsWindows = async (): Promise<DiscoveredApp[]> => {
  const apps: DiscoveredApp[] = [];
  const seen = new Set<string>();

  try {
    // PowerShell: Get only processes with a visible main window
    // MainWindowHandle -ne 0 means the process has a visible window
    // This filters out ALL background processes automatically
    // Using -EncodedCommand to avoid shell escaping issues with $_
    const psScript = `
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
Select-Object ProcessName, Path, MainWindowTitle |
ConvertTo-Json -Compress
`;
    // Encode the script as Base64 for -EncodedCommand
    const encoded = Buffer.from(psScript.trim(), "utf16le").toString("base64");

    const output = await execAsync(
      `powershell -NoProfile -EncodedCommand ${encoded}`
    );

    if (!output || output === "null") return apps;

    // PowerShell returns single object without array brackets
    const parsed = JSON.parse(output.startsWith("[") ? output : `[${output}]`);

    for (const proc of parsed) {
      const name = proc.ProcessName?.trim();
      const exePath = proc.Path?.trim();

      if (!name) continue;

      // Skip if no path (usually system internals)
      if (!exePath) continue;

      // Skip Windows system components
      if (isWindowsSystemPath(exePath)) continue;

      const cleanedName = cleanAppName(name);
      const key = cleanedName.toLowerCase();

      if (seen.has(key)) continue;
      seen.add(key);

      apps.push({
        name: cleanedName,
        executablePath: exePath,
        source: "running",
      });
    }
  } catch (error) {
    log("Failed to get running apps (Windows):", error);
  }

  return apps;
};

// ---------------------------------------------------------------------------
// macOS: Running Apps (user-facing only)
// ---------------------------------------------------------------------------

const discoverRunningAppsMac = async (): Promise<DiscoveredApp[]> => {
  const apps: DiscoveredApp[] = [];
  const seen = new Set<string>();

  try {
    // Use lsappinfo instead of osascript+System Events to avoid Automation permission dialog
    const output = await execAsync(`lsappinfo list -apps`);

    for (const line of output.split("\n")) {
      const nameMatch = line.match(/"LSDisplayName"\s*=\s*"([^"]+)"/);
      if (!nameMatch) continue;
      const trimmed = nameMatch[1].trim();
      if (!trimmed) continue;

      const bundleMatch = line.match(/"CFBundleIdentifier"\s*=\s*"([^"]+)"/);
      const pathMatch = line.match(/"LSBundlePath"\s*=\s*"([^"]+)"/);
      const appPath = pathMatch?.[1] ?? "";

      let executablePath = appPath?.trim() || "";

      // If we got a .app bundle, that's usable with `open` command
      // For direct execution, we could resolve to Contents/MacOS/name
      if (!executablePath) {
        // Fallback: try standard locations
        const standardPaths = [
          `/Applications/${trimmed}.app`,
          `/System/Applications/${trimmed}.app`,
          path.join(os.homedir(), "Applications", `${trimmed}.app`),
        ];

        for (const p of standardPaths) {
          try {
            await fs.access(p);
            executablePath = p;
            break;
          } catch {
            // Try next
          }
        }
      }

      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      apps.push({
        name: trimmed,
        executablePath: executablePath || `/Applications/${trimmed}.app`,
        source: "running",
      });
    }
  } catch (error) {
    log("Failed to get running apps (macOS):", error);

    // Fallback: use lsappinfo which lists GUI apps
    try {
      const output = await execAsync("lsappinfo list | grep 'bundlepath\\|name'");
      const lines = output.split("\n");

      let currentName = "";
      for (const line of lines) {
        const nameMatch = line.match(/"name"\s*=\s*"([^"]+)"/);
        const pathMatch = line.match(/"bundlepath"\s*=\s*"([^"]+)"/);

        if (nameMatch) {
          currentName = nameMatch[1];
        } else if (pathMatch && currentName) {
          const key = currentName.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            apps.push({
              name: currentName,
              executablePath: pathMatch[1],
              source: "running",
            });
          }
          currentName = "";
        }
      }
    } catch {
      // Give up
    }
  }

  return apps;
};

// ---------------------------------------------------------------------------
// Windows: Recently Used Apps via UserAssist Registry
// ---------------------------------------------------------------------------

/** ROT13 decode — UserAssist obfuscates app names with ROT13 */
const rot13 = (s: string): string =>
  s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

/**
 * UserAssist entries that are OS infrastructure, not user apps.
 * Matched against the decoded name (case-insensitive).
 */
const USERASSIST_NOISE = new Set([
  "microsoft.windows.explorer",
  "microsoft.windows.shellexperiencehost",
  "microsoft.windows.startmenuexperiencehost",
  "microsoft.windows.search",
  "microsoft.windows.cortana",
  "microsoft.lockapp",
  "microsoft.screensketch",
  "microsoft.windowscalculator",
  "microsoft.windowscamera",
  "microsoft.windows.photos",
  "microsoft.autogenerated",
  "microsoft.windowsalarms",
  "microsoft.getstarted",
  "microsoft.549981c3f5f10", // Cortana
  "microsoft.windowscommunicationsapps",
  "microsoftwindows.client.cbs",
  "windows.immersivecontrolpanel",
]);

const isUserAssistNoise = (decoded: string): boolean => {
  const lower = decoded.toLowerCase();
  // Skip system GUIDs, shell folders, etc.
  if (lower.startsWith("ueme_")) return true;
  // Skip Windows system paths
  if (lower.includes("\\windows\\system32\\")) return true;
  if (lower.includes("\\windows\\syswow64\\")) return true;
  // Skip browser profile sub-entries (e.g. "Chrome.UserData.Profile1")
  if (lower.includes(".userdata.")) return true;
  // Skip migrators, installers, updaters
  if (lower.includes("migrator")) return true;
  if (lower.includes("installer")) return true;
  if (lower.includes("setup") && lower.endsWith(".exe")) return true;
  // Skip apps launched from Downloads (one-off runs, not installed apps)
  if (lower.includes("\\downloads\\")) return true;
  // Skip known noise apps
  for (const noise of USERASSIST_NOISE) {
    if (lower.startsWith(noise) || lower.includes(noise)) return true;
  }
  return false;
};

/** Well-known exe/id → display name mappings */
const EXE_DISPLAY_NAMES: Record<string, string> = {
  i_view64: "IrfanView",
  obs64: "OBS Studio",
  obs32: "OBS Studio",
  msedge: "Microsoft Edge",
  wt: "Windows Terminal",
  cmd: "Command Prompt",
  powershell: "PowerShell",
  pwsh: "PowerShell",
  code: "Visual Studio Code",
  windowsnotepad: "Notepad",
  spotifymusic: "Spotify",
  anthropicclaude: "Claude",
  riotclientservices: "Riot Client",
};

/** Extract a clean app name from a UserAssist decoded entry */
const cleanUserAssistName = (decoded: string): string => {
  // UWP apps: "CompanyName.AppName_hash!EntryPoint" → "AppName"
  const uwpMatch = decoded.match(/(?:^|\\)([^\\]+?)_[a-z0-9]+![A-Za-z0-9]+$/);
  if (uwpMatch) {
    // Use the entry point name if it's more descriptive (e.g. "ubuntu2404")
    const entryPoint = decoded.match(/!([A-Za-z0-9]+)$/)?.[1];
    const parts = uwpMatch[1].split(".");
    const lastPart = parts[parts.length - 1];

    // Prefer entry point if it's a real name (not "App" or "Main")
    const name = entryPoint && !["App", "Main", "Spotify"].includes(entryPoint)
      ? entryPoint
      : lastPart;
    return EXE_DISPLAY_NAMES[name.toLowerCase()] ?? name;
  }

  // Squirrel apps: "com.squirrel.Discord.Discord" → "Discord"
  const squirrelMatch = decoded.match(/^com\.squirrel\.([^.]+)\./);
  if (squirrelMatch) {
    const name = squirrelMatch[1];
    // Check display name map (case-insensitive, handles mangled names)
    if (name.toLowerCase().includes("claude")) return "Claude";
    return name;
  }

  // "Valve.Steam.Client" / "Anysphere.Cursor" / "Telegram.TelegramDesktop" style
  const dottedMatch = decoded.match(/^[A-Z][a-zA-Z0-9]+\.[A-Z][a-zA-Z0-9.]+$/);
  if (dottedMatch) {
    const parts = decoded.split(".");
    // Try full name lookup first (e.g. "AnthropicClaude")
    const joined = parts.join("");
    if (EXE_DISPLAY_NAMES[joined.toLowerCase()]) return EXE_DISPLAY_NAMES[joined.toLowerCase()];

    // Strip generic last segments entirely
    const genericLast = new Set(["Client", "Settings", "Installer", "Updater"]);
    const meaningful = parts.filter((p) => !genericLast.has(p));
    if (meaningful.length === 0) return "";

    // Strip generic suffixes from the last meaningful part
    let last = meaningful[meaningful.length - 1];
    const suffixes = ["Desktop", "ForWindows", "Music"];
    for (const suffix of suffixes) {
      if (last.endsWith(suffix) && last.length > suffix.length) {
        last = last.slice(0, -suffix.length);
        break;
      }
    }

    // If company.AppName pattern (2 parts), return the app name part
    if (meaningful.length >= 2) {
      return EXE_DISPLAY_NAMES[last.toLowerCase()] ?? last;
    }
    return EXE_DISPLAY_NAMES[last.toLowerCase()] ?? last;
  }

  // com.todesktop/com.pais etc: skip opaque IDs
  if (decoded.startsWith("com.") && !decoded.includes("\\")) {
    const parts = decoded.split(".");
    if (parts.length >= 3 && /^[a-z0-9]+$/i.test(parts[parts.length - 1])) return "";
    return parts[parts.length - 1];
  }

  // Exe paths: extract exe name and apply display name mapping
  const exeMatch = decoded.match(/([^\\]+?)\.exe$/i);
  if (exeMatch) {
    const raw = exeMatch[1];
    return EXE_DISPLAY_NAMES[raw.toLowerCase()] ?? raw;
  }

  // Simple app names: "Chrome", "Brave"
  if (!decoded.includes("\\") && !decoded.includes("{") && !decoded.includes("_")) {
    return EXE_DISPLAY_NAMES[decoded.toLowerCase()] ?? decoded;
  }

  return "";
};

/** Extract executable path from UserAssist decoded entry if present */
const extractUserAssistPath = (decoded: string): string => {
  // Resolve {6D809377...} GUID to Program Files
  const resolved = decoded
    .replace(/\{6D809377-6AF0-444B-8957-A3773F02200E\}/gi, "C:\\Program Files")
    .replace(/\{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7\}/gi, "C:\\Windows\\System32");

  if (resolved.toLowerCase().endsWith(".exe")) return resolved;
  return "";
};

/**
 * Read UserAssist registry to discover recently launched apps (Windows only).
 * UserAssist tracks every GUI app launch with run count and last-run timestamp.
 * App names are ROT13-obfuscated in the registry.
 */
const discoverUserAssistApps = async (): Promise<DiscoveredApp[]> => {
  if (process.platform !== "win32") return [];

  const apps: DiscoveredApp[] = [];
  const cutoffTime = Date.now() - USERASSIST_DAYS * 24 * 60 * 60 * 1000;

  try {
    // PowerShell script to read UserAssist binary values
    const psScript = `
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count'
$values = Get-ItemProperty -Path $path
foreach ($name in $values.PSObject.Properties.Name) {
  if ($name -like 'PS*') { continue }
  $data = $values.$name
  if ($data -is [byte[]]) {
    $hex = [BitConverter]::ToString($data) -replace '-',''
    Write-Output "$name||||$hex"
  }
}
`;
    const encoded = Buffer.from(psScript.trim(), "utf16le").toString("base64");
    const output = await execAsync(
      `powershell -NoProfile -EncodedCommand ${encoded}`,
    );

    const seen = new Set<string>();

    for (const line of output.split("\n")) {
      if (!line.includes("||||")) continue;
      const [encodedName, hexData] = line.trim().split("||||");
      if (!encodedName || !hexData) continue;

      const decoded = rot13(encodedName);

      // Skip noise
      if (isUserAssistNoise(decoded)) continue;

      // Parse binary: FILETIME at offset 60 (8 bytes LE)
      const bytes = Buffer.from(hexData, "hex");
      if (bytes.length < 68) continue;

      const low = bytes.readUInt32LE(60);
      const high = bytes.readUInt32LE(64);
      const fileTime = BigInt(high) * 4294967296n + BigInt(low);
      const lastRunMs = Number(fileTime / 10000n - 11644473600000n);

      // Skip if outside recency window or invalid
      if (lastRunMs < cutoffTime || lastRunMs > Date.now() + 86400000) continue;

      const name = cleanUserAssistName(decoded);
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const exePath = extractUserAssistPath(decoded);

      apps.push({
        name: cleanAppName(name),
        executablePath: exePath,
        source: "recent",
        lastUsed: lastRunMs,
      });
    }
  } catch (error) {
    log("Failed to read UserAssist registry:", error);
  }

  return apps;
};

// ---------------------------------------------------------------------------
// Recently Used Apps (via data folder mtime)
// ---------------------------------------------------------------------------

type KnownApp = {
  name: string;
  dataPath: {
    win32?: string;
    darwin?: string;
  };
  exePath: {
    win32?: string;
    darwin?: string;
  };
};

const getKnownApps = (): KnownApp[] => {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const macSupport = path.join(home, "Library", "Application Support");

  return [
    // Communication
    {
      name: "Slack",
      dataPath: {
        win32: path.join(appData, "Slack"),
        darwin: path.join(macSupport, "Slack"),
      },
      exePath: {
        win32: path.join(localAppData, "slack", "slack.exe"),
        darwin: "/Applications/Slack.app",
      },
    },
    {
      name: "Discord",
      dataPath: {
        win32: path.join(appData, "discord"),
        darwin: path.join(macSupport, "discord"),
      },
      exePath: {
        win32: path.join(localAppData, "Discord", "Update.exe"),
        darwin: "/Applications/Discord.app",
      },
    },
    {
      name: "Microsoft Teams",
      dataPath: {
        win32: path.join(appData, "Microsoft", "Teams"),
        darwin: path.join(macSupport, "Microsoft Teams"),
      },
      exePath: {
        win32: path.join(localAppData, "Microsoft", "Teams", "Update.exe"),
        darwin: "/Applications/Microsoft Teams.app",
      },
    },
    {
      name: "Zoom",
      dataPath: {
        win32: path.join(appData, "Zoom"),
        darwin: path.join(macSupport, "zoom.us"),
      },
      exePath: {
        win32: path.join(appData, "Zoom", "bin", "Zoom.exe"),
        darwin: "/Applications/zoom.us.app",
      },
    },
    {
      name: "Telegram",
      dataPath: {
        win32: path.join(localAppData, "Telegram Desktop"),
        darwin: path.join(macSupport, "Telegram Desktop"),
      },
      exePath: {
        win32: path.join(localAppData, "Telegram Desktop", "Telegram.exe"),
        darwin: "/Applications/Telegram.app",
      },
    },
    // Dev Tools
    {
      name: "Visual Studio Code",
      dataPath: {
        win32: path.join(appData, "Code"),
        darwin: path.join(macSupport, "Code"),
      },
      exePath: {
        win32: path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
        darwin: "/Applications/Visual Studio Code.app",
      },
    },
    {
      name: "Cursor",
      dataPath: {
        win32: path.join(appData, "Cursor"),
        darwin: path.join(macSupport, "Cursor"),
      },
      exePath: {
        win32: path.join(localAppData, "Programs", "cursor", "Cursor.exe"),
        darwin: "/Applications/Cursor.app",
      },
    },
    {
      name: "Docker Desktop",
      dataPath: {
        win32: path.join(appData, "Docker"),
        darwin: path.join(macSupport, "Docker"),
      },
      exePath: {
        win32: "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
        darwin: "/Applications/Docker.app",
      },
    },
    {
      name: "Postman",
      dataPath: {
        win32: path.join(appData, "Postman"),
        darwin: path.join(macSupport, "Postman"),
      },
      exePath: {
        win32: path.join(localAppData, "Postman", "Postman.exe"),
        darwin: "/Applications/Postman.app",
      },
    },
    // Media
    {
      name: "Spotify",
      dataPath: {
        win32: path.join(appData, "Spotify"),
        darwin: path.join(macSupport, "Spotify"),
      },
      exePath: {
        win32: path.join(appData, "Spotify", "Spotify.exe"),
        darwin: "/Applications/Spotify.app",
      },
    },
    // Browsers (for launching specific browser)
    {
      name: "Arc",
      dataPath: {
        win32: path.join(localAppData, "Arc"),
        darwin: path.join(macSupport, "Arc"),
      },
      exePath: {
        win32: path.join(localAppData, "Arc", "Arc.exe"),
        darwin: "/Applications/Arc.app",
      },
    },
    // Productivity
    {
      name: "Notion",
      dataPath: {
        win32: path.join(appData, "Notion"),
        darwin: path.join(macSupport, "Notion"),
      },
      exePath: {
        win32: path.join(localAppData, "Programs", "Notion", "Notion.exe"),
        darwin: "/Applications/Notion.app",
      },
    },
    {
      name: "Figma",
      dataPath: {
        win32: path.join(appData, "Figma"),
        darwin: path.join(macSupport, "Figma"),
      },
      exePath: {
        win32: path.join(localAppData, "Figma", "Figma.exe"),
        darwin: "/Applications/Figma.app",
      },
    },
    {
      name: "Obsidian",
      dataPath: {
        win32: path.join(appData, "obsidian"),
        darwin: path.join(macSupport, "obsidian"),
      },
      exePath: {
        win32: path.join(localAppData, "Obsidian", "Obsidian.exe"),
        darwin: "/Applications/Obsidian.app",
      },
    },
  ];
};

const discoverRecentlyUsedApps = async (): Promise<DiscoveredApp[]> => {
  const platform = process.platform as "win32" | "darwin";
  const cutoffTime = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;
  const apps: DiscoveredApp[] = [];

  const knownApps = getKnownApps();

  const checks = knownApps
    .filter((app) => app.dataPath[platform] && app.exePath[platform])
    .map(async (app) => {
      const dataPath = app.dataPath[platform]!;
      const exePath = app.exePath[platform]!;
      try {
        const stat = await fs.stat(dataPath);
        if (stat.isDirectory() && stat.mtimeMs >= cutoffTime) {
          await fs.access(exePath);
          return {
            name: app.name,
            executablePath: exePath,
            source: "recent" as const,
            lastUsed: stat.mtimeMs,
          };
        }
      } catch {
        // Data folder doesn't exist or exe missing
      }
      return null;
    });

  const results = await Promise.all(checks);
  for (const result of results) {
    if (result) apps.push(result);
  }

  return apps;
};

// ---------------------------------------------------------------------------
// Main Discovery
// ---------------------------------------------------------------------------

export const discoverApps = async (): Promise<AppDiscoveryResult> => {
  log("Starting app discovery...");

  const platform = process.platform;

  // Collect running apps, recently used, and UserAssist in parallel
  const runningAppsPromise =
    platform === "win32"
      ? discoverRunningAppsWindows()
      : platform === "darwin"
        ? discoverRunningAppsMac()
        : Promise.resolve([]);

  const [runningApps, recentApps, userAssistApps] = await Promise.all([
    runningAppsPromise,
    discoverRecentlyUsedApps(),
    discoverUserAssistApps(),
  ]);

  log(`Found ${runningApps.length} running apps`);
  log(`Found ${recentApps.length} recently used apps`);
  if (userAssistApps.length > 0) {
    log(`Found ${userAssistApps.length} apps from UserAssist (last ${USERASSIST_DAYS}d)`);
  }

  // Merge: running > data-folder-recent > UserAssist
  // Build a set of normalized names for dedup across sources
  const normalizeForDedup = (name: string): string =>
    name.toLowerCase()
      .replace(/\s+/g, "")
      .replace(/^microsoft\s*/i, "")
      .replace(/\.exe$/i, "");

  const seenNames = new Set<string>();
  for (const a of runningApps) seenNames.add(normalizeForDedup(a.name));

  const filteredRecent = recentApps.filter((a) => {
    const key = normalizeForDedup(a.name);
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  const filteredUserAssist = userAssistApps.filter((a) => {
    const key = normalizeForDedup(a.name);
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  const allApps = [...runningApps, ...filteredRecent, ...filteredUserAssist];

  // Sort: running first, then by recency
  allApps.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "running" ? -1 : 1;
    }
    // Both recent: sort by lastUsed
    if (a.lastUsed && b.lastUsed) {
      return b.lastUsed - a.lastUsed;
    }
    return 0;
  });

  // Limit total
  const limited = allApps.slice(0, 40);

  log(`Total discovered apps: ${limited.length}`);

  return { apps: limited };
};

// ---------------------------------------------------------------------------
// Synthesis Formatting
// ---------------------------------------------------------------------------

/**
 * Apps that are OS infrastructure / always running — zero user-signal.
 * Matched case-insensitively against cleaned app name.
 */
const NOISE_APPS = new Set([
  "explorer",
  "finder",
  "systemuiserver",
  "dock",
  "spotlight",
  "windowserver",
  "notepad",
  "nvidia share",
  "nvidia geforce experience",
  "nvidia geforce overlay",
  "geforce experience",
  "realtek audio console",
  "security health",
  "widgets",
  "text input host",
  "applicationframehost",
  "shellexperiencehost",
  "searchhost",
  "startmenuexperiencehost",
  "lockapp",
  "gamebar",
  "gamebarpresencewriter",
  "runtime broker",
  "ctfmon",
  "msedgewebview2",
  "crashpad",
]);

const isSynthesisNoise = (app: DiscoveredApp): boolean =>
  NOISE_APPS.has(app.name.toLowerCase());

/**
 * Format a single app entry for synthesis.
 * Includes executable path so Stella can launch apps from core memory.
 */
const formatAppEntry = (app: DiscoveredApp): string => {
  if (app.executablePath) {
    return `- ${app.name}: \`${app.executablePath}\``;
  }
  return `- ${app.name}`;
};

/**
 * Format app discovery for LLM synthesis.
 * Filters OS noise. Omits paths (raw data retains them for launch).
 */
export const formatAppDiscoveryForSynthesis = (result: AppDiscoveryResult): string => {
  if (result.apps.length === 0) return "";

  const sections: string[] = ["## Apps"];

  const running = result.apps.filter((a) => a.source === "running" && !isSynthesisNoise(a));
  const recent = result.apps.filter((a) => a.source === "recent" && !isSynthesisNoise(a));

  if (running.length > 0) {
    sections.push("\n### Currently Running");
    sections.push(running.slice(0, 15).map(formatAppEntry).join("\n"));
  }

  if (recent.length > 0) {
    sections.push("\n### Recently Used");
    sections.push(recent.slice(0, 10).map(formatAppEntry).join("\n"));
  }

  return sections.join("\n");
};
