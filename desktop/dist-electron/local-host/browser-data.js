/**
 * Browser Data Collection Script
 *
 * Extracts browsing patterns from local browser databases.
 * Runs once on first launch to populate core memory data.
 *
 * Detection strategy:
 * 1. Detect the user's DEFAULT browser from OS settings
 * 2. Find the LAST USED profile from the browser's Local State file
 * 3. Fall back to checking all browsers/profiles if detection fails
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
const openDatabase = async (dbPath) => {
    if (typeof globalThis.Bun !== "undefined") {
        // @ts-expect-error bun:sqlite only available at runtime in Bun
        const { Database: BunDatabase } = await import("bun:sqlite");
        return new BunDatabase(dbPath, { readonly: true });
    }
    const { default: Database } = await import("better-sqlite3");
    return new Database(dbPath, { readonly: true });
};
const log = (...args) => console.log("[browser-data]", ...args);
// Profile variants to check (Default is most common, but users may have multiple)
const PROFILE_VARIANTS = ["Default", "Profile 1", "Profile 2", "Profile 3"];
/**
 * Generate path variants for all profile combinations
 */
const generateProfilePaths = (basePath) => {
    return PROFILE_VARIANTS.map((profile) => basePath.replace("/Default/", `/${profile}/`));
};
const BROWSER_CONFIGS = [
    {
        type: "chrome",
        paths: {
            win32: [
                // Standard Chrome installation with all profile variants
                ...generateProfilePaths("Google/Chrome/User Data/Default/History"),
                // Some installations use "User" instead of "User Data"
                ...generateProfilePaths("Google/Chrome/User/Default/History"),
                // Chrome Beta
                ...generateProfilePaths("Google/Chrome Beta/User Data/Default/History"),
                // Chrome Canary
                ...generateProfilePaths("Google/Chrome SxS/User Data/Default/History"),
            ],
            darwin: [
                ...generateProfilePaths("Google/Chrome/Default/History"),
                ...generateProfilePaths("Google/Chrome Beta/Default/History"),
                ...generateProfilePaths("Google/Chrome Canary/Default/History"),
            ],
            linux: [
                ...generateProfilePaths(".config/google-chrome/Default/History"),
                ...generateProfilePaths(".config/google-chrome-beta/Default/History"),
                ...generateProfilePaths(".config/chromium/Default/History"),
            ],
        },
    },
    {
        type: "arc",
        paths: {
            win32: [
                // Arc browser (Windows - relatively new)
                ...generateProfilePaths("Arc/User Data/Default/History"),
            ],
            darwin: [
                // Arc is primarily macOS
                ...generateProfilePaths("Arc/User Data/Default/History"),
            ],
            linux: [],
        },
    },
    {
        type: "edge",
        paths: {
            win32: [
                ...generateProfilePaths("Microsoft/Edge/User Data/Default/History"),
                ...generateProfilePaths("Microsoft/Edge/User/Default/History"),
                ...generateProfilePaths("Microsoft/Edge Beta/User Data/Default/History"),
                ...generateProfilePaths("Microsoft/Edge Dev/User Data/Default/History"),
            ],
            darwin: [
                ...generateProfilePaths("Microsoft Edge/Default/History"),
                ...generateProfilePaths("Microsoft Edge Beta/Default/History"),
            ],
            linux: [
                ...generateProfilePaths(".config/microsoft-edge/Default/History"),
                ...generateProfilePaths(".config/microsoft-edge-beta/Default/History"),
            ],
        },
    },
    {
        type: "brave",
        paths: {
            win32: [
                ...generateProfilePaths("BraveSoftware/Brave-Browser/User Data/Default/History"),
                ...generateProfilePaths("BraveSoftware/Brave-Browser/User/Default/History"),
            ],
            darwin: [
                ...generateProfilePaths("BraveSoftware/Brave-Browser/Default/History"),
            ],
            linux: [
                ...generateProfilePaths(".config/BraveSoftware/Brave-Browser/Default/History"),
            ],
        },
    },
    {
        type: "opera",
        paths: {
            win32: [
                "Opera Software/Opera Stable/History",
                "Opera Software/Opera GX Stable/History",
            ],
            darwin: [
                "com.operasoftware.Opera/History",
                "com.operasoftware.OperaGX/History",
            ],
            linux: [
                ".config/opera/History",
            ],
        },
    },
    {
        type: "vivaldi",
        paths: {
            win32: [
                ...generateProfilePaths("Vivaldi/User Data/Default/History"),
            ],
            darwin: [
                ...generateProfilePaths("Vivaldi/Default/History"),
            ],
            linux: [
                ...generateProfilePaths(".config/vivaldi/Default/History"),
            ],
        },
    },
];
// ---------------------------------------------------------------------------
// Default Browser Detection
// ---------------------------------------------------------------------------
/**
 * Execute a shell command and return stdout
 */
const execAsync = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, { encoding: "utf-8" }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            }
            else {
                resolve(stdout.trim());
            }
        });
    });
};
/**
 * Browser process names for each platform
 */
const BROWSER_PROCESSES = {
    chrome: {
        win32: ["chrome.exe"],
        darwin: ["Google Chrome"],
        linux: ["chrome", "google-chrome", "chromium"],
    },
    edge: {
        win32: ["msedge.exe"],
        darwin: ["Microsoft Edge"],
        linux: ["msedge", "microsoft-edge"],
    },
    brave: {
        win32: ["brave.exe"],
        darwin: ["Brave Browser"],
        linux: ["brave", "brave-browser"],
    },
    arc: {
        win32: ["Arc.exe"],
        darwin: ["Arc"],
        linux: [],
    },
    opera: {
        win32: ["opera.exe"],
        darwin: ["Opera"],
        linux: ["opera"],
    },
    vivaldi: {
        win32: ["vivaldi.exe"],
        darwin: ["Vivaldi"],
        linux: ["vivaldi"],
    },
};
/**
 * Detect currently running browsers by checking active processes
 * Returns browsers in order of priority (Chrome first, etc.)
 */
const detectRunningBrowsers = async () => {
    const platform = process.platform;
    const running = [];
    try {
        let processList;
        if (platform === "win32") {
            // Windows: use tasklist
            processList = await execAsync("tasklist /FO CSV /NH");
        }
        else if (platform === "darwin") {
            // macOS: use ps
            processList = await execAsync("ps -eo comm");
        }
        else {
            // Linux: use ps
            processList = await execAsync("ps -eo comm");
        }
        const processListLower = processList.toLowerCase();
        // Check each browser in priority order
        const browserOrder = ["chrome", "arc", "edge", "brave", "opera", "vivaldi"];
        for (const browser of browserOrder) {
            const processNames = BROWSER_PROCESSES[browser]?.[platform] || [];
            for (const processName of processNames) {
                if (processListLower.includes(processName.toLowerCase())) {
                    running.push(browser);
                    break; // Found this browser, move to next
                }
            }
        }
        if (running.length > 0) {
            log("Running browsers detected:", running);
        }
    }
    catch (error) {
        log("Failed to detect running browsers:", error);
    }
    return running;
};
/**
 * Detect the default browser on Windows via registry
 */
const detectDefaultBrowserWindows = async () => {
    try {
        // Query the registry for the default http handler
        // Use double backslashes for the registry path
        const output = await execAsync('reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId');
        const progId = output.toLowerCase();
        log("Registry ProgId output:", progId);
        // Match common ProgId values:
        // Chrome: ChromeHTML, ChromeHTM
        // Edge: MSEdgeHTM, MSEdgeDHTML  
        // Brave: BraveHTML, BraveHTM
        // etc.
        if (progId.includes("chromehtm") || progId.includes("chromehtml"))
            return "chrome";
        if (progId.includes("msedge") || progId.includes("edgehtm"))
            return "edge";
        if (progId.includes("bravehtm") || progId.includes("bravehtml"))
            return "brave";
        if (progId.includes("archtml") || progId.includes("archtml"))
            return "arc";
        if (progId.includes("operahtml") || progId.includes("operahtm"))
            return "opera";
        if (progId.includes("vivaldi"))
            return "vivaldi";
        // Firefox not supported (different DB format)
        log("Could not match ProgId to a supported browser");
        return null;
    }
    catch (error) {
        log("Failed to detect default browser on Windows:", error);
        return null;
    }
};
/**
 * Detect the default browser on macOS
 */
const detectDefaultBrowserMac = async () => {
    try {
        // Use LaunchServices to find the default browser
        const output = await execAsync("defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | grep -A2 'LSHandlerURLScheme = http;' | grep LSHandlerRoleAll | head -1");
        const bundleId = output.toLowerCase();
        if (bundleId.includes("chrome"))
            return "chrome";
        if (bundleId.includes("edge"))
            return "edge";
        if (bundleId.includes("brave"))
            return "brave";
        if (bundleId.includes("arc"))
            return "arc";
        if (bundleId.includes("opera"))
            return "opera";
        if (bundleId.includes("vivaldi"))
            return "vivaldi";
        log("Default browser bundle ID:", bundleId);
        return null;
    }
    catch {
        // Fallback: try open command
        try {
            const output = await execAsync("perl -MMac::InternetConfig -le 'print +(GetICHelper \"http\")[1]' 2>/dev/null || true");
            const app = output.toLowerCase();
            if (app.includes("chrome"))
                return "chrome";
            if (app.includes("safari"))
                return null; // Safari not supported
        }
        catch {
            // Ignore
        }
        return null;
    }
};
/**
 * Detect the default browser on Linux
 */
const detectDefaultBrowserLinux = async () => {
    try {
        const output = await execAsync("xdg-settings get default-web-browser 2>/dev/null");
        const desktop = output.toLowerCase();
        if (desktop.includes("chrome") || desktop.includes("chromium"))
            return "chrome";
        if (desktop.includes("edge"))
            return "edge";
        if (desktop.includes("brave"))
            return "brave";
        if (desktop.includes("opera"))
            return "opera";
        if (desktop.includes("vivaldi"))
            return "vivaldi";
        log("Default browser desktop file:", desktop);
        return null;
    }
    catch {
        return null;
    }
};
/**
 * Detect the user's default browser from OS settings
 */
const detectDefaultBrowser = async () => {
    const platform = process.platform;
    switch (platform) {
        case "win32":
            return detectDefaultBrowserWindows();
        case "darwin":
            return detectDefaultBrowserMac();
        case "linux":
            return detectDefaultBrowserLinux();
        default:
            return null;
    }
};
// ---------------------------------------------------------------------------
// Profile Detection
// ---------------------------------------------------------------------------
/**
 * Browser base directories (without profile path)
 */
const BROWSER_BASE_DIRS = {
    chrome: {
        win32: "Google/Chrome/User Data",
        win32Alt: "Google/Chrome/User",
        darwin: "Google/Chrome",
        linux: ".config/google-chrome",
    },
    edge: {
        win32: "Microsoft/Edge/User Data",
        darwin: "Microsoft Edge",
        linux: ".config/microsoft-edge",
    },
    brave: {
        win32: "BraveSoftware/Brave-Browser/User Data",
        darwin: "BraveSoftware/Brave-Browser",
        linux: ".config/BraveSoftware/Brave-Browser",
    },
    arc: {
        win32: "Arc/User Data",
        darwin: "Arc/User Data",
        linux: "",
    },
    opera: {
        win32: "Opera Software/Opera Stable",
        darwin: "com.operasoftware.Opera",
        linux: ".config/opera",
    },
    vivaldi: {
        win32: "Vivaldi/User Data",
        darwin: "Vivaldi",
        linux: ".config/vivaldi",
    },
};
/**
 * Find the most recently used profile by checking folder modification times
 * This is more reliable than parsing Local State JSON
 */
const getMostRecentlyUsedProfile = async (browserType) => {
    const platform = process.platform;
    const basePath = getBasePath(platform);
    // Get browser's base directory
    const browserDirs = [
        BROWSER_BASE_DIRS[browserType]?.[platform],
        platform === "win32" ? BROWSER_BASE_DIRS[browserType]?.win32Alt : null,
    ].filter(Boolean);
    if (browserDirs.length === 0)
        return "Default";
    // Profile patterns to look for
    const profilePatterns = ["Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4", "Profile 5"];
    // Check all profile paths in parallel
    const profileChecks = browserDirs.flatMap((browserDir) => {
        const userDataPath = path.join(basePath, browserDir);
        return profilePatterns.map(async (profile) => {
            const profilePath = path.join(userDataPath, profile);
            try {
                const stat = await fs.stat(profilePath);
                if (!stat.isDirectory())
                    return null;
                const historyPath = path.join(profilePath, "History");
                try {
                    const historyStat = await fs.stat(historyPath);
                    return { profile, mtime: historyStat.mtimeMs };
                }
                catch {
                    return { profile, mtime: stat.mtimeMs };
                }
            }
            catch {
                return null;
            }
        });
    });
    const profileResults = await Promise.all(profileChecks);
    let mostRecentProfile = "Default";
    let mostRecentTime = 0;
    for (const result of profileResults) {
        if (result && result.mtime > mostRecentTime) {
            mostRecentTime = result.mtime;
            mostRecentProfile = result.profile;
        }
    }
    if (mostRecentTime > 0) {
        const lastModified = new Date(mostRecentTime).toISOString();
        log(`Most recent profile for ${browserType}: ${mostRecentProfile} (last modified: ${lastModified})`);
    }
    return mostRecentProfile;
};
/**
 * Get the history path for a specific browser and profile
 */
const getHistoryPathForBrowserProfile = async (browserType, profile) => {
    const platform = process.platform;
    const basePath = getBasePath(platform);
    const browserDir = BROWSER_BASE_DIRS[browserType]?.[platform];
    if (!browserDir)
        return null;
    // Try main path
    const historyPath = path.join(basePath, browserDir, profile, "History");
    try {
        await fs.access(historyPath);
        return historyPath;
    }
    catch {
        // Try alternate path on Windows
        if (platform === "win32" && BROWSER_BASE_DIRS[browserType]?.win32Alt) {
            const altDir = BROWSER_BASE_DIRS[browserType].win32Alt;
            const altHistoryPath = path.join(basePath, altDir, profile, "History");
            try {
                await fs.access(altHistoryPath);
                return altHistoryPath;
            }
            catch {
                // Path doesn't exist
            }
        }
    }
    return null;
};
const getBasePath = (platform) => {
    const home = os.homedir();
    switch (platform) {
        case "win32":
            return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        case "darwin":
            return path.join(home, "Library", "Application Support");
        default:
            return home;
    }
};
/**
 * Get all possible history paths for a browser type
 */
const getBrowserHistoryPaths = (browserType, platform) => {
    const config = BROWSER_CONFIGS.find((c) => c.type === browserType);
    if (!config)
        return [];
    const basePath = getBasePath(platform);
    const relativePaths = config.paths[platform];
    if (!relativePaths || relativePaths.length === 0)
        return [];
    return relativePaths.map((rel) => path.join(basePath, rel));
};
const parseProfileFromHistoryPath = (historyPath) => {
    const segments = historyPath.split(/[\\/]+/).filter(Boolean);
    const profile = segments.find((segment) => segment === "Default" || /^Profile \d+$/i.test(segment));
    return profile ?? null;
};
// ---------------------------------------------------------------------------
// Chrome Time Conversion
// ---------------------------------------------------------------------------
// Chrome stores timestamps as microseconds since January 1, 1601
const CHROME_EPOCH_OFFSET = 11644473600000; // ms between 1601 and 1970
const toChromeTime = (date) => {
    return (date.getTime() + CHROME_EPOCH_OFFSET) * 1000; // to microseconds
};
// ---------------------------------------------------------------------------
// Title Noise Filters
// ---------------------------------------------------------------------------
// Titles that are universally noise (technical issues, not content)
const NOISE_TITLE_PATTERNS = [
    // Cloudflare/loading challenges
    /^just a moment\.{0,3}$/i,
    /^loading\.{0,3}$/i,
    /^please wait\.{0,3}$/i,
    /^redirecting\.{0,3}$/i,
    // HTTP errors
    /^access denied/i,
    /^403 forbidden/i,
    /^404 not found/i,
    /^500 /i,
    /^error$/i,
    // Empty/placeholder titles
    /^untitled$/i,
    /^new tab$/i,
    // Raw URLs as titles (page didn't have a real title)
    /^https?:\/\//i,
    /^\w+\.\w+\/[\w/-]+$/, // Matches "domain.com/path/to/page" patterns
];
// Auth/infrastructure domains to exclude from title queries
const AUTH_DOMAINS = [
    "accounts.google.com",
    "login.",
    "auth.",
    "oauth.",
    "signin.",
    "sso.",
    "id.",
];
// ---------------------------------------------------------------------------
// Domain Normalization
// ---------------------------------------------------------------------------
/**
 * Normalize a domain by stripping common prefixes (www, m, mobile)
 * This collapses variations like www.github.com and github.com into one entry
 */
const normalizeDomain = (domain) => {
    let normalized = domain.toLowerCase().trim();
    // Strip common prefixes (order matters - check longer prefixes first)
    const prefixes = ["www.", "mobile.", "m."];
    for (const prefix of prefixes) {
        if (normalized.startsWith(prefix)) {
            normalized = normalized.slice(prefix.length);
            break; // Only strip one prefix
        }
    }
    return normalized;
};
/**
 * Filter and aggregate domain visit rows
 * - Removes empty domains
 * - Normalizes domains (strips www/m/mobile prefixes)
 * - Aggregates visits by normalized domain
 * - Sorts by visit count descending
 */
const filterAndAggregateDomains = (rows) => {
    const aggregated = new Map();
    for (const { domain, visits } of rows) {
        if (!domain || domain.length === 0)
            continue;
        const normalized = normalizeDomain(domain);
        aggregated.set(normalized, (aggregated.get(normalized) || 0) + visits);
    }
    return Array.from(aggregated.entries())
        .map(([domain, visits]) => ({ domain, visits }))
        .sort((a, b) => b.visits - a.visits);
};
// ---------------------------------------------------------------------------
// SQL Queries
// ---------------------------------------------------------------------------
// Query 1: Top cluster domains (session-based groupings)
// Note: clusters table may not exist in all browser versions
const CLUSTER_QUERY = `
SELECT label, COUNT(*) as sessions 
FROM clusters 
WHERE label != '' 
  AND label NOT LIKE '%localhost%' 
  AND label NOT LIKE '%127.0.0.1%' 
GROUP BY label 
ORDER BY sessions DESC 
LIMIT 40
`;
// Query 2: Most active domains (last 7 days)
const RECENT_DOMAINS_QUERY = `
SELECT 
  SUBSTR(
    SUBSTR(u.url, INSTR(u.url, '://') + 3), 
    1, 
    CASE 
      WHEN INSTR(SUBSTR(u.url, INSTR(u.url, '://') + 3), '/') = 0 
      THEN LENGTH(SUBSTR(u.url, INSTR(u.url, '://') + 3)) 
      ELSE INSTR(SUBSTR(u.url, INSTR(u.url, '://') + 3), '/') - 1 
    END
  ) as domain, 
  COUNT(*) as visits 
FROM urls u 
JOIN visits v ON u.id = v.url 
WHERE v.visit_time > ?
  AND u.url NOT LIKE '%localhost%'
  AND u.url NOT LIKE '%127.0.0.1%'
  AND u.url NOT LIKE '%file://%'
  AND u.url NOT LIKE '%chrome://%'
  AND u.url NOT LIKE '%edge://%'
  AND u.url NOT LIKE '%brave://%'
GROUP BY domain 
ORDER BY visits DESC 
LIMIT 30
`;
// Query 3: Page titles for a specific domain
const DOMAIN_TITLES_QUERY = `
SELECT title, url, visit_count 
FROM urls 
WHERE url LIKE ? 
  AND title != '' 
ORDER BY visit_count DESC 
LIMIT 25
`;
// Query 4: All-time top domains (by total visit count)
const ALL_TIME_DOMAINS_QUERY = `
SELECT 
  SUBSTR(
    SUBSTR(url, INSTR(url, '://') + 3), 
    1, 
    CASE 
      WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') = 0 
      THEN LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) 
      ELSE INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1 
    END
  ) as domain, 
  SUM(visit_count) as visits 
FROM urls
WHERE url NOT LIKE '%localhost%'
  AND url NOT LIKE '%127.0.0.1%'
  AND url NOT LIKE '%file://%'
  AND url NOT LIKE '%chrome://%'
  AND url NOT LIKE '%edge://%'
  AND url NOT LIKE '%brave://%'
GROUP BY domain 
ORDER BY visits DESC 
LIMIT 50
`;
// ---------------------------------------------------------------------------
// Main Collection Logic
// ---------------------------------------------------------------------------
/**
 * Find the most recently modified browser history across ALL browsers
 * Returns the browser with the most recently modified history file
 */
const findMostRecentlyModifiedBrowser = async () => {
    // Check all browsers in parallel
    const candidateResults = await Promise.all(BROWSER_CONFIGS.map(async (config) => {
        const recentProfile = await getMostRecentlyUsedProfile(config.type);
        const historyPath = await getHistoryPathForBrowserProfile(config.type, recentProfile);
        if (!historyPath)
            return null;
        try {
            const stat = await fs.stat(historyPath);
            return { type: config.type, historyPath, mtime: stat.mtimeMs };
        }
        catch {
            return null;
        }
    }));
    const candidates = candidateResults.filter((c) => c !== null);
    if (candidates.length === 0) {
        return null;
    }
    // Sort by modification time, most recent first
    candidates.sort((a, b) => b.mtime - a.mtime);
    const winner = candidates[0];
    log(`Most recently modified browser: ${winner.type} (modified ${new Date(winner.mtime).toISOString()})`);
    return winner;
};
/**
 * Find the user's browser with history data
 *
 * Strategy (in order of reliability):
 * 1. Check currently RUNNING browsers (most accurate - what they're using right now)
 * 2. Detect default browser from OS settings
 * 3. Find most recently modified browser history
 * 4. Fall back to checking all browsers in priority order
 */
const findBrowser = async () => {
    const platform = process.platform;
    // Steps 1 & 2: Detect running browsers and OS default browser in parallel
    log("Detecting running browsers and OS default browser...");
    const [runningBrowsers, defaultBrowser] = await Promise.all([
        detectRunningBrowsers(),
        detectDefaultBrowser(),
    ]);
    // Prefer running browsers (most reliable)
    if (runningBrowsers.length > 0) {
        for (const browser of runningBrowsers) {
            const lastProfile = await getMostRecentlyUsedProfile(browser);
            const historyPath = await getHistoryPathForBrowserProfile(browser, lastProfile);
            if (historyPath) {
                log(`Found ${browser} history (currently running, ${lastProfile} profile) at: ${historyPath}`);
                return { type: browser, historyPath, profile: lastProfile };
            }
        }
        log("Running browsers detected but history not accessible, continuing...");
    }
    // Fall back to OS default browser
    if (defaultBrowser) {
        log(`OS default browser: ${defaultBrowser}`);
        const lastProfile = await getMostRecentlyUsedProfile(defaultBrowser);
        const historyPath = await getHistoryPathForBrowserProfile(defaultBrowser, lastProfile);
        if (historyPath) {
            log(`Found ${defaultBrowser} history (OS default, ${lastProfile} profile) at: ${historyPath}`);
            return { type: defaultBrowser, historyPath, profile: lastProfile };
        }
        if (lastProfile !== "Default") {
            const defaultHistoryPath = await getHistoryPathForBrowserProfile(defaultBrowser, "Default");
            if (defaultHistoryPath) {
                log(`Found ${defaultBrowser} history (OS default, Default profile) at: ${defaultHistoryPath}`);
                return { type: defaultBrowser, historyPath: defaultHistoryPath, profile: "Default" };
            }
        }
        log(`OS default browser ${defaultBrowser} detected but history not accessible, falling back...`);
    }
    else {
        log("Could not detect OS default browser, trying most recently modified...");
    }
    // Step 3: Find the most recently modified browser history
    log("Finding most recently modified browser...");
    const mostRecent = await findMostRecentlyModifiedBrowser();
    if (mostRecent) {
        log(`Using most recently modified: ${mostRecent.type} at ${mostRecent.historyPath}`);
        return {
            type: mostRecent.type,
            historyPath: mostRecent.historyPath,
            profile: parseProfileFromHistoryPath(mostRecent.historyPath),
        };
    }
    // Step 4: Check all browsers in priority order (exhaustive search)
    log("Most recent detection failed, checking all browsers in priority order...");
    for (const config of BROWSER_CONFIGS) {
        const historyPaths = getBrowserHistoryPaths(config.type, platform);
        for (const historyPath of historyPaths) {
            try {
                await fs.access(historyPath);
                log(`Found ${config.type} history at: ${historyPath}`);
                return {
                    type: config.type,
                    historyPath,
                    profile: parseProfileFromHistoryPath(historyPath),
                };
            }
            catch {
                continue;
            }
        }
    }
    log("No browser history found");
    return null;
};
/**
 * Copy the history database to a temporary location
 * (Browsers lock the original file while running)
 *
 * Also copies WAL files (-wal, -shm) if they exist, as Chrome uses
 * Write-Ahead Logging and recent data may be in these files.
 */
const copyHistoryDatabase = async (historyPath, StellaHome) => {
    const cacheDir = path.join(StellaHome, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const timestamp = Date.now();
    const tempPath = path.join(cacheDir, `browser_history_${timestamp}.db`);
    // Copy main database file
    await fs.copyFile(historyPath, tempPath);
    log(`Copied history to: ${tempPath}`);
    // Copy WAL files in parallel for complete data (Chrome uses Write-Ahead Logging)
    await Promise.all(["-wal", "-shm"].map(async (ext) => {
        try {
            await fs.copyFile(historyPath + ext, tempPath + ext);
            log(`Copied WAL file: ${ext}`);
        }
        catch {
            // WAL file doesn't exist or can't be copied - that's OK
        }
    }));
    return tempPath;
};
/**
 * Run cluster query (may not exist in all browsers)
 */
const queryClusterDomains = (db) => {
    try {
        const rows = db.prepare(CLUSTER_QUERY).all();
        return rows.map((r) => r.label);
    }
    catch {
        // clusters table doesn't exist in this browser version
        log("Clusters table not available");
        return [];
    }
};
// Fallback query: Get top domains from urls table directly (no time filter)
// Used when the visits-based query returns empty
const FALLBACK_DOMAINS_QUERY = `
SELECT 
  SUBSTR(
    SUBSTR(url, INSTR(url, '://') + 3), 
    1, 
    CASE 
      WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') = 0 
      THEN LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) 
      ELSE INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1 
    END
  ) as domain, 
  SUM(visit_count) as visits 
FROM urls 
WHERE url NOT LIKE '%localhost%'
  AND url NOT LIKE '%127.0.0.1%'
  AND url NOT LIKE '%file://%'
  AND url NOT LIKE '%chrome://%'
  AND url NOT LIKE '%edge://%'
  AND url NOT LIKE '%brave://%'
  AND visit_count > 0
GROUP BY domain 
ORDER BY visits DESC 
LIMIT 30
`;
/**
 * Query most visited domains in the last 7 days
 * Falls back to all-time data if recent data is empty
 */
const queryRecentDomains = (db) => {
    const sevenDaysAgo = toChromeTime(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    // Try time-filtered query first
    try {
        const rows = db.prepare(RECENT_DOMAINS_QUERY).all(sevenDaysAgo);
        const result = filterAndAggregateDomains(rows);
        if (result.length > 0)
            return result;
        log("No recent domains found, trying fallback query...");
    }
    catch (error) {
        log("Error querying recent domains, trying fallback:", error);
    }
    // Fallback: Query all-time data from urls table
    try {
        const rows = db.prepare(FALLBACK_DOMAINS_QUERY).all();
        return filterAndAggregateDomains(rows);
    }
    catch (error) {
        log("Fallback query also failed:", error);
        return [];
    }
};
/**
 * Check if a title is noise (Cloudflare challenge, loading state, etc.)
 */
const isNoiseTitle = (title) => {
    const trimmed = title.trim();
    if (!trimmed)
        return true;
    return NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
};
/**
 * Check if a domain is auth/infrastructure (excluded from title queries)
 */
const isAuthDomain = (domain) => {
    const lower = domain.toLowerCase();
    return AUTH_DOMAINS.some((auth) => lower.includes(auth));
};
/**
 * Extract top domains to query for content details
 * Uses the user's actual top visited domains instead of a hardcoded list
 */
const getTopDomainsForDetails = (domains, limit = 15) => {
    return domains
        .filter((d) => !isAuthDomain(d.domain))
        .slice(0, limit)
        .map((d) => d.domain);
};
/**
 * Query page titles for the user's top domains
 * Dynamically determined from their actual browsing patterns
 * Deduplicates by title and aggregates visit counts
 */
const queryDomainDetails = (db, topDomains) => {
    const details = {};
    for (const domain of topDomains) {
        try {
            const rows = db.prepare(DOMAIN_TITLES_QUERY).all(`%${domain}%`);
            // Filter noise and deduplicate by normalized title
            const titleMap = new Map();
            for (const row of rows) {
                if (isNoiseTitle(row.title))
                    continue;
                const key = row.title.trim().toLowerCase();
                const existing = titleMap.get(key);
                if (existing) {
                    existing.visitCount += row.visit_count;
                }
                else {
                    titleMap.set(key, {
                        title: row.title,
                        url: row.url,
                        visitCount: row.visit_count,
                    });
                }
            }
            if (titleMap.size > 0) {
                // Sort by visit count and limit to top 15
                details[domain] = Array.from(titleMap.values())
                    .sort((a, b) => b.visitCount - a.visitCount)
                    .slice(0, 15);
            }
        }
        catch {
            // Skip domains that fail
        }
    }
    return details;
};
/**
 * Query all-time top domains by cumulative visit count
 */
const queryAllTimeDomains = (db) => {
    try {
        const rows = db.prepare(ALL_TIME_DOMAINS_QUERY).all();
        return filterAndAggregateDomains(rows);
    }
    catch (error) {
        log("All-time domains query failed:", error);
        return [];
    }
};
const emptyBrowserData = (browser = null) => ({
    browser,
    clusterDomains: [],
    recentDomains: [],
    allTimeDomains: [],
    domainDetails: {},
});
/**
 * Collect browser data from the user's default browser
 */
export const collectBrowserData = async (StellaHome) => {
    log("Starting browser data collection...");
    const browser = await findBrowser();
    if (!browser)
        return emptyBrowserData();
    let tempDbPath = null;
    let db = null;
    try {
        tempDbPath = await copyHistoryDatabase(browser.historyPath, StellaHome);
        db = await openDatabase(tempDbPath);
        // Run queries
        const clusterDomains = queryClusterDomains(db);
        const recentDomains = queryRecentDomains(db);
        const rawAllTimeDomains = queryAllTimeDomains(db);
        // Soft dedupe: exclude domains from all-time that already appear in recent
        const recentDomainSet = new Set(recentDomains.map((d) => d.domain.toLowerCase()));
        const allTimeDomains = rawAllTimeDomains
            .filter((d) => !recentDomainSet.has(d.domain.toLowerCase()))
            .slice(0, 20);
        // Get titles for combined top domains
        const combinedDomains = [
            ...new Set([
                ...getTopDomainsForDetails(recentDomains, 15),
                ...getTopDomainsForDetails(allTimeDomains, 10),
            ]),
        ];
        const domainDetails = queryDomainDetails(db, combinedDomains);
        log("Collection complete:", {
            browser: browser.type,
            clusterDomains: clusterDomains.length,
            recentDomains: recentDomains.length,
            allTimeDomains: allTimeDomains.length,
            domainDetails: Object.keys(domainDetails).length,
        });
        return {
            browser: browser.type,
            clusterDomains,
            recentDomains,
            allTimeDomains,
            domainDetails,
        };
    }
    catch (error) {
        log("Error collecting browser data:", error);
        return emptyBrowserData(browser.type);
    }
    finally {
        db?.close?.();
        if (tempDbPath) {
            for (const suffix of ["", "-wal", "-shm"]) {
                fs.unlink(tempDbPath + suffix).catch(() => { });
            }
            log("Cleaned up temp database");
        }
    }
};
/**
 * Check if core memory already exists
 */
export const coreMemoryExists = async (StellaHome) => {
    const coreMemoryPath = path.join(StellaHome, "state", "CORE_MEMORY.MD");
    try {
        await fs.access(coreMemoryPath);
        return true;
    }
    catch {
        return false;
    }
};
/**
 * Write core memory profile to disk
 */
export const writeCoreMemory = async (StellaHome, content) => {
    const statePath = path.join(StellaHome, "state");
    await fs.mkdir(statePath, { recursive: true });
    const coreMemoryPath = path.join(statePath, "CORE_MEMORY.MD");
    await fs.writeFile(coreMemoryPath, content, "utf-8");
    log("Wrote CORE_MEMORY.MD");
};
const formatDomainList = (domains) => domains.map((d) => `${d.domain} (${d.visits})`).join("\n");
/**
 * Format browser data for LLM synthesis input
 */
export const formatBrowserDataForSynthesis = (data) => {
    if (!data.browser)
        return "No browser data available.";
    const sections = [`## Browser Data (${data.browser})`];
    if (data.recentDomains.length > 0) {
        sections.push("\n### Most Active (Last 7 Days)");
        sections.push(formatDomainList(data.recentDomains));
    }
    if (data.allTimeDomains.length > 0) {
        sections.push("\n### Long-term Interests (All-time, excluding recent)");
        sections.push(formatDomainList(data.allTimeDomains));
    }
    if (Object.keys(data.domainDetails).length > 0) {
        sections.push("\n### Content Details");
        for (const [domain, titles] of Object.entries(data.domainDetails)) {
            sections.push(`\n**${domain}**`);
            sections.push(titles.map((t) => `- ${t.title} (${t.visitCount})`).join("\n"));
        }
    }
    return sections.join("\n");
};
export const detectPreferredBrowserProfile = async () => {
    const browser = await findBrowser();
    if (!browser) {
        return { browser: null, profile: null };
    }
    return {
        browser: browser.type,
        profile: browser.profile,
    };
};
