import { promises as fs } from "fs";
import path from "path";
import os from "os";
const log = (...args) => console.log("[browser-bookmarks]", ...args);
function getAppDataDir() {
    const platform = os.platform();
    if (platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support");
    }
    else if (platform === "win32") {
        return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    }
    else {
        return path.join(os.homedir(), ".config");
    }
}
function getRoamingAppDataDir() {
    if (os.platform() === "win32") {
        return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    }
    return getAppDataDir();
}
function walkBookmarkTree(node, parentFolder) {
    const entries = [];
    if (!node || typeof node !== "object") {
        return entries;
    }
    const bookmark = node;
    if (bookmark.type === "url") {
        const title = bookmark.name?.trim();
        const url = bookmark.url?.trim();
        if (title &&
            url &&
            !url.startsWith("chrome://") &&
            !url.startsWith("edge://") &&
            !url.startsWith("about:")) {
            entries.push({
                title,
                url,
                folder: parentFolder,
            });
        }
    }
    else if (bookmark.type === "folder" && bookmark.children) {
        const folderName = bookmark.name?.trim() || parentFolder;
        for (const child of bookmark.children) {
            entries.push(...walkBookmarkTree(child, folderName));
        }
    }
    return entries;
}
export async function collectBrowserBookmarks() {
    const appDataDir = getAppDataDir();
    const roamingAppDataDir = getRoamingAppDataDir();
    const platform = os.platform();
    const defaultChromiumProfiles = ["Default", "Profile 1", "Profile 2", "Profile 3"];
    const browsers = [
        {
            name: "Chrome",
            basePath: platform === "darwin"
                ? path.join(appDataDir, "Google", "Chrome")
                : path.join(appDataDir, "Google", "Chrome", "User Data"),
            profiles: defaultChromiumProfiles,
        },
        {
            name: "Arc",
            basePath: path.join(appDataDir, "Arc", "User Data"),
            profiles: defaultChromiumProfiles,
        },
        {
            name: "Edge",
            basePath: platform === "darwin"
                ? path.join(appDataDir, "Microsoft Edge")
                : path.join(appDataDir, "Microsoft", "Edge", "User Data"),
            profiles: defaultChromiumProfiles,
        },
        {
            name: "Brave",
            basePath: platform === "darwin"
                ? path.join(appDataDir, "BraveSoftware", "Brave-Browser")
                : path.join(appDataDir, "BraveSoftware", "Brave-Browser", "User Data"),
            profiles: defaultChromiumProfiles,
        },
        {
            name: "Vivaldi",
            basePath: platform === "darwin"
                ? path.join(appDataDir, "Vivaldi")
                : path.join(appDataDir, "Vivaldi", "User Data"),
            profiles: defaultChromiumProfiles,
        },
        {
            name: "Opera",
            basePath: platform === "darwin"
                ? path.join(appDataDir, "com.operasoftware.Opera")
                : platform === "win32"
                    ? path.join(roamingAppDataDir, "Opera Software", "Opera Stable")
                    : path.join(os.homedir(), ".config", "opera"),
            profiles: ["", "Default"],
        },
    ];
    for (const browser of browsers) {
        for (const profile of browser.profiles) {
            try {
                const bookmarksPath = profile
                    ? path.join(browser.basePath, profile, "Bookmarks")
                    : path.join(browser.basePath, "Bookmarks");
                const content = await fs.readFile(bookmarksPath, "utf-8");
                const data = JSON.parse(content);
                if (!data.roots) {
                    continue;
                }
                let allEntries = [];
                if (data.roots.bookmark_bar) {
                    allEntries.push(...walkBookmarkTree(data.roots.bookmark_bar));
                }
                if (data.roots.other) {
                    allEntries.push(...walkBookmarkTree(data.roots.other));
                }
                if (data.roots.synced) {
                    allEntries.push(...walkBookmarkTree(data.roots.synced));
                }
                if (allEntries.length === 0) {
                    continue;
                }
                // Limit to 200 bookmarks
                if (allEntries.length > 200) {
                    allEntries = allEntries.slice(0, 200);
                }
                // Extract unique folder names
                const folders = new Set();
                for (const entry of allEntries) {
                    if (entry.folder) {
                        folders.add(entry.folder);
                    }
                }
                log(`Found ${allEntries.length} bookmarks in ${browser.name} (${profile})`);
                return {
                    browser: browser.name,
                    bookmarks: allEntries,
                    folders: Array.from(folders),
                };
            }
            catch {
                // Silently continue to next browser/profile
                continue;
            }
        }
    }
    log("No bookmarks found in any browser");
    return null;
}
function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname;
    }
    catch {
        return url;
    }
}
export function formatBrowserBookmarksForSynthesis(data) {
    if (!data) {
        return "";
    }
    let output = `## Browser Bookmarks (${data.browser})\n`;
    // Folders section
    if (data.folders.length > 0) {
        output += `### Bookmark Folders\n`;
        output += data.folders.join(", ") + "\n\n";
    }
    // Group bookmarks by folder
    const byFolder = new Map();
    const uncategorized = [];
    for (const bookmark of data.bookmarks) {
        if (bookmark.folder) {
            const existing = byFolder.get(bookmark.folder) || [];
            existing.push(bookmark);
            byFolder.set(bookmark.folder, existing);
        }
        else {
            uncategorized.push(bookmark);
        }
    }
    // Bookmarks by folder (limit to 15 folders, 10 bookmarks each)
    if (byFolder.size > 0) {
        output += `### Bookmarks by Folder\n`;
        const folders = Array.from(byFolder.entries()).slice(0, 15);
        for (const [folder, bookmarks] of folders) {
            output += `**${folder}**\n`;
            const limitedBookmarks = bookmarks.slice(0, 10);
            for (const bookmark of limitedBookmarks) {
                const domain = extractDomain(bookmark.url);
                output += `- ${bookmark.title} (${domain})\n`;
            }
            output += "\n";
        }
    }
    // Uncategorized bookmarks (limit to 20)
    if (uncategorized.length > 0) {
        output += `### Uncategorized Bookmarks\n`;
        const limitedUncategorized = uncategorized.slice(0, 20);
        for (const bookmark of limitedUncategorized) {
            const domain = extractDomain(bookmark.url);
            output += `- ${bookmark.title} (${domain})\n`;
        }
        output += "\n";
    }
    return output;
}
