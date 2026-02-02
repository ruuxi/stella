/**
 * App Discovery
 *
 * Discovers apps with executable paths for Stellar to launch.
 * Sources:
 * 1. Currently running apps (highest signal)
 * 2. Recently used apps (check data folder mtime)
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
const log = (...args) => console.log("[app-discovery]", ...args);
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// How many days to consider an app "recently used"
const RECENCY_DAYS = 7;
// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------
const execAsync = (command, shell) => {
    return new Promise((resolve, reject) => {
        exec(command, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, shell }, (error, stdout) => {
            if (error)
                reject(error);
            else
                resolve(stdout.trim());
        });
    });
};
/**
 * Clean app name for display
 */
const cleanAppName = (name) => {
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
const isWindowsSystemPath = (exePath) => {
    const lower = exePath.toLowerCase();
    return (lower.includes("\\windows\\systemapps\\") ||
        lower.includes("\\windows\\system32\\") ||
        lower.includes("\\windows\\syswow64\\"));
};
const discoverRunningAppsWindows = async () => {
    const apps = [];
    const seen = new Set();
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
        const output = await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`);
        if (!output || output === "null")
            return apps;
        // PowerShell returns single object without array brackets
        const parsed = JSON.parse(output.startsWith("[") ? output : `[${output}]`);
        for (const proc of parsed) {
            const name = proc.ProcessName?.trim();
            const exePath = proc.Path?.trim();
            if (!name)
                continue;
            // Skip if no path (usually system internals)
            if (!exePath)
                continue;
            // Skip Windows system components
            if (isWindowsSystemPath(exePath))
                continue;
            const cleanedName = cleanAppName(name);
            const key = cleanedName.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            apps.push({
                name: cleanedName,
                executablePath: exePath,
                source: "running",
            });
        }
    }
    catch (error) {
        log("Failed to get running apps (Windows):", error);
    }
    return apps;
};
// ---------------------------------------------------------------------------
// macOS: Running Apps (user-facing only)
// ---------------------------------------------------------------------------
const discoverRunningAppsMac = async () => {
    const apps = [];
    const seen = new Set();
    try {
        // AppleScript: Get user-facing apps (background only = false)
        // Also get the bundle path directly for each app
        const script = `
      tell application "System Events"
        set appList to {}
        repeat with p in (processes whose background only is false)
          try
            set appPath to POSIX path of (file of p as alias)
            set end of appList to (name of p) & "|||" & appPath
          on error
            set end of appList to (name of p) & "|||"
          end try
        end repeat
        return appList as text
      end tell
    `;
        const output = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
        for (const entry of output.split(", ")) {
            const [name, appPath] = entry.split("|||");
            const trimmed = name?.trim();
            if (!trimmed)
                continue;
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
                    }
                    catch {
                        // Try next
                    }
                }
            }
            const key = trimmed.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            apps.push({
                name: trimmed,
                executablePath: executablePath || `/Applications/${trimmed}.app`,
                source: "running",
            });
        }
    }
    catch (error) {
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
                }
                else if (pathMatch && currentName) {
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
        }
        catch {
            // Give up
        }
    }
    return apps;
};
const getKnownApps = () => {
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
const discoverRecentlyUsedApps = async () => {
    const platform = process.platform;
    const cutoffTime = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;
    const apps = [];
    const knownApps = getKnownApps();
    for (const app of knownApps) {
        const dataPath = app.dataPath[platform];
        const exePath = app.exePath[platform];
        if (!dataPath || !exePath)
            continue;
        try {
            const stat = await fs.stat(dataPath);
            if (stat.isDirectory() && stat.mtimeMs >= cutoffTime) {
                // Verify exe exists
                try {
                    await fs.access(exePath);
                }
                catch {
                    continue; // Exe doesn't exist
                }
                apps.push({
                    name: app.name,
                    executablePath: exePath,
                    source: "recent",
                    lastUsed: stat.mtimeMs,
                });
            }
        }
        catch {
            // Data folder doesn't exist, app not used
        }
    }
    return apps;
};
// ---------------------------------------------------------------------------
// Main Discovery
// ---------------------------------------------------------------------------
export const discoverApps = async () => {
    log("Starting app discovery...");
    const platform = process.platform;
    // Collect running apps
    const runningApps = platform === "win32"
        ? await discoverRunningAppsWindows()
        : platform === "darwin"
            ? await discoverRunningAppsMac()
            : [];
    log(`Found ${runningApps.length} running apps`);
    // Collect recently used apps
    const recentApps = await discoverRecentlyUsedApps();
    log(`Found ${recentApps.length} recently used apps`);
    // Merge: running apps take priority
    const runningNames = new Set(runningApps.map((a) => a.name.toLowerCase()));
    const filteredRecent = recentApps.filter((a) => !runningNames.has(a.name.toLowerCase()));
    const allApps = [...runningApps, ...filteredRecent];
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
/**
 * Format a single app entry with path for LLM synthesis
 */
const formatAppEntry = (app) => {
    if (app.executablePath) {
        return `- ${app.name}: \`${app.executablePath}\``;
    }
    return `- ${app.name}`;
};
/**
 * Format app discovery for LLM synthesis
 * Includes executable paths so Stellar can launch apps
 */
export const formatAppDiscoveryForSynthesis = (result) => {
    if (result.apps.length === 0)
        return "";
    const sections = ["## Apps"];
    const running = result.apps.filter((a) => a.source === "running");
    const recent = result.apps.filter((a) => a.source === "recent");
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
