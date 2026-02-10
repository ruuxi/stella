/**
 * Dev Projects Discovery
 *
 * Finds active development projects by scanning for git repos
 * and checking recency via .git folder modification times.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
const log = (...args) => console.log("[dev-projects]", ...args);
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// How many days back to consider a project "active"
const RECENCY_DAYS = 30;
// Maximum depth to scan for .git folders
const MAX_DEPTH = 4;
// Directories to skip
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "vendor",
    "target",
    "build",
    "dist",
    ".cache",
    ".npm",
    ".pnpm",
    ".yarn",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".cargo",
    ".rustup",
    "go",
    ".local",
    ".config",
    "Library",
    "AppData",
    "Application Data",
    "Applications",
    "Program Files",
    "Program Files (x86)",
    "Windows",
]);
// Common project directories to scan
const getProjectRoots = () => {
    const home = os.homedir();
    const platform = process.platform;
    const roots = [
        path.join(home, "projects"),
        path.join(home, "repos"),
        path.join(home, "code"),
        path.join(home, "dev"),
        path.join(home, "src"),
        path.join(home, "work"),
        path.join(home, "workspace"),
        path.join(home, "git"),
        path.join(home, "GitHub"),
    ];
    if (platform === "darwin") {
        roots.push(path.join(home, "Developer"));
    }
    if (platform === "win32") {
        // Common Windows dev locations
        roots.push("C:\\dev");
        roots.push("C:\\projects");
        roots.push("C:\\repos");
    }
    // Also check Documents folder
    roots.push(path.join(home, "Documents"));
    return roots;
};
// ---------------------------------------------------------------------------
// Git Repo Detection
// ---------------------------------------------------------------------------
/**
 * Check if a directory is a git repository and get its last activity time
 * Returns null if not a git repo or can't determine activity time
 */
const getGitRepoActivity = async (dir) => {
    const gitDir = path.join(dir, ".git");
    try {
        const stat = await fs.stat(gitDir);
        if (!stat.isDirectory())
            return null;
        // Check multiple files to get the most recent activity
        const filesToCheck = [
            path.join(gitDir, "index"), // Updated on most git operations
            path.join(gitDir, "HEAD"), // Updated on checkout
            path.join(gitDir, "FETCH_HEAD"), // Updated on fetch
            path.join(gitDir, "logs", "HEAD"), // Reflog
        ];
        const fileStats = await Promise.all(filesToCheck.map((file) => fs.stat(file).catch(() => null)));
        let mostRecent = 0;
        for (const fileStat of fileStats) {
            if (fileStat && fileStat.mtimeMs > mostRecent) {
                mostRecent = fileStat.mtimeMs;
            }
        }
        // Fall back to .git folder mtime if no files found
        return mostRecent > 0 ? mostRecent : stat.mtimeMs;
    }
    catch {
        return null;
    }
};
/**
 * Recursively scan a directory for git repos
 */
const scanForGitRepos = async (dir, depth, cutoffTime, results) => {
    if (depth > MAX_DEPTH)
        return;
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        // Check if this directory is a git repo
        const hasGit = entries.some((e) => e.isDirectory() && e.name === ".git");
        if (hasGit) {
            const lastActivity = await getGitRepoActivity(dir);
            if (lastActivity && lastActivity >= cutoffTime) {
                const name = path.basename(dir);
                results.push({
                    name,
                    path: dir,
                    lastActivity,
                });
            }
            // Don't recurse into git repos (submodules are rare and add complexity)
            return;
        }
        // Recurse into subdirectories
        const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name));
        // Limit parallel scans to avoid too many open handles
        const batchSize = 10;
        for (let i = 0; i < subdirs.length; i += batchSize) {
            const batch = subdirs.slice(i, i + batchSize);
            await Promise.all(batch.map((subdir) => scanForGitRepos(path.join(dir, subdir.name), depth + 1, cutoffTime, results)));
        }
    }
    catch {
        // Directory not accessible, skip
    }
};
// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------
export const collectDevProjects = async () => {
    log("Starting dev projects discovery...");
    const projectRoots = getProjectRoots();
    const cutoffTime = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;
    const results = [];
    // Check which roots exist (parallel stat)
    const rootStats = await Promise.all(projectRoots.map(async (root) => {
        try {
            const stat = await fs.stat(root);
            return stat.isDirectory() ? root : null;
        }
        catch {
            return null;
        }
    }));
    const existingRoots = rootStats.filter((r) => r !== null);
    log(`Scanning ${existingRoots.length} project roots:`, existingRoots);
    // Scan all roots for git repos in parallel
    await Promise.all(existingRoots.map((root) => scanForGitRepos(root, 0, cutoffTime, results)));
    // Deduplicate by path (in case roots overlap)
    const seen = new Set();
    const unique = results.filter((p) => {
        const key = p.path.toLowerCase();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    // Sort by most recent activity
    unique.sort((a, b) => b.lastActivity - a.lastActivity);
    // Limit to top 30 projects
    const limited = unique.slice(0, 30);
    log(`Found ${limited.length} active projects (last ${RECENCY_DAYS} days)`);
    return limited;
};
/**
 * Format dev projects for LLM synthesis
 */
export const formatDevProjectsForSynthesis = (projects) => {
    if (projects.length === 0)
        return "";
    const sections = ["## Active Projects"];
    sections.push("\n" +
        projects
            .slice(0, 15)
            .map((p) => {
            const daysAgo = Math.floor((Date.now() - p.lastActivity) / (24 * 60 * 60 * 1000));
            const recency = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
            return `- ${p.name} (${p.path}) (${recency})`;
        })
            .join("\n"));
    return sections.join("\n");
};
