/**
 * Shared utilities for the tools system.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
// Constants
export const MAX_OUTPUT = 30000;
export const MAX_FILE_BYTES = 1000000;
const SENSITIVE_KEY_RE = /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|client[-_]?secret|session|csrf|x[-_]api[-_]key)/i;
const URL_SECRET_RE = /([?&](?:api[-_]?key|token|access_token|refresh_token|session|secret|password)=)([^&#\s]+)/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const BASIC_RE = /\b(Basic)\s+[A-Za-z0-9+/=]+\b/gi;
const COOKIE_INLINE_RE = /\b(cookie|set-cookie)\s*:\s*([^\n\r;]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const redactString = (input) => input
    .replace(URL_SECRET_RE, "$1[REDACTED]")
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(BASIC_RE, "$1 [REDACTED]")
    .replace(COOKIE_INLINE_RE, "$1: [REDACTED]")
    .replace(JWT_RE, "[REDACTED]");
const sanitizeSensitiveData = (value, depth = 0, seen = new WeakSet()) => {
    if (depth > 8)
        return "[TRUNCATED]";
    if (typeof value === "string")
        return redactString(value);
    if (typeof value !== "object" || value === null)
        return value;
    if (seen.has(value))
        return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeSensitiveData(entry, depth + 1, seen));
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            output[key] = "[REDACTED]";
            continue;
        }
        output[key] = sanitizeSensitiveData(entry, depth + 1, seen);
    }
    return output;
};
// Logging
export const log = (...args) => console.log("[tools]", ...args.map((entry) => sanitizeSensitiveData(entry)));
export const logError = (...args) => console.error("[tools]", ...args.map((entry) => sanitizeSensitiveData(entry)));
export const sanitizeForLogs = (value) => sanitizeSensitiveData(value);
// Path utilities
export const ensureAbsolutePath = (filePath) => {
    if (!path.isAbsolute(filePath)) {
        return {
            ok: false,
            error: `file_path must be absolute. Received: ${filePath}`,
        };
    }
    return { ok: true };
};
export const toPosix = (value) => value.replace(/\\/g, "/");
export const expandHomePath = (value) => {
    const home = os.homedir();
    const userProfile = process.env.USERPROFILE || home;
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");
    const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
    // Expand "~" (unix + Git Bash style).
    let expanded = value.replace(/^~(?=$|[\\/])/, home);
    // Expand common env placeholders used in prompts/tool args.
    // Note: SqliteQuery/Read/Glob/Grep run in Node (not bash), so we must expand
    // these ourselves if the agent includes them.
    expanded = expanded
        .replace(/\$USERPROFILE\b/gi, userProfile)
        .replace(/%USERPROFILE%/gi, userProfile)
        .replace(/\$LOCALAPPDATA\b/gi, localAppData)
        .replace(/%LOCALAPPDATA%/gi, localAppData)
        .replace(/\$APPDATA\b/gi, appData)
        .replace(/%APPDATA%/gi, appData)
        .replace(/\$TEMP\b/gi, tempDir)
        .replace(/%TEMP%/gi, tempDir)
        .replace(/\$TMP\b/gi, tempDir)
        .replace(/%TMP%/gi, tempDir)
        .replace(/\$HOME\b/gi, home)
        .replace(/%HOME%/gi, home)
        // Windows doesn't have /tmp, but prompts sometimes include it.
        .replace(/\/tmp\b/g, tempDir);
    return expanded;
};
// String utilities
export const truncate = (value, max = MAX_OUTPUT) => value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;
// Directory utilities
export const isIgnoredDir = (name) => name === "node_modules" ||
    name === ".git" ||
    name === "dist" ||
    name === "dist-electron" ||
    name === "release";
export const globToRegExp = (pattern) => {
    const escaped = pattern
        .split("")
        .map((char) => {
        if (char === "*")
            return "__STAR__";
        if (char === "?")
            return "__Q__";
        return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    })
        .join("");
    const withStars = escaped
        .replace(/__STAR____STAR__/g, ".*")
        .replace(/__STAR__/g, "[^/]*")
        .replace(/__Q__/g, ".");
    return new RegExp(`^${withStars}$`);
};
export const walkFiles = async (basePath) => {
    const results = [];
    const stack = [basePath];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!isIgnoredDir(entry.name)) {
                    stack.push(fullPath);
                }
                continue;
            }
            if (entry.isFile()) {
                results.push(fullPath);
            }
        }
    }
    return results;
};
// File utilities
export const readFileSafe = async (filePath) => {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_BYTES) {
        return {
            ok: false,
            error: `File too large to read safely (${stat.size} bytes): ${filePath}`,
        };
    }
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return { ok: true, content };
    }
    catch {
        const buffer = await fs.readFile(filePath);
        const base64 = buffer.toString("base64");
        return {
            ok: true,
            content: `[binary:${buffer.byteLength} bytes]\n${truncate(base64, 4000)}`,
        };
    }
};
export const formatWithLineNumbers = (content, offset = 1, limit = 2000) => {
    const lines = content.split("\n");
    const startLine = Math.max(0, offset - 1);
    const endLine = Math.min(lines.length, startLine + limit);
    const selected = lines.slice(startLine, endLine);
    const body = selected
        .map((line, index) => {
        const lineNum = startLine + index + 1;
        const truncatedLine = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
        return `${String(lineNum).padStart(6, " ")}\t${truncatedLine}`;
    })
        .join("\n");
    return {
        header: `File has ${lines.length} lines. Showing ${startLine + 1}-${endLine}.`,
        body,
    };
};
// HTML utilities
export const stripHtml = (html) => {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};
// State utilities
export const getStatePath = (stateRoot, kind, id) => path.join(stateRoot, kind, `${id}.json`);
export const loadJson = async (filePath, fallback) => {
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
};
export const saveJson = async (filePath, value) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
};
// Secret file utilities
const tightenWindowsAcl = async (resolvedPath) => {
    if (process.platform !== "win32") {
        return;
    }
    const username = process.env.USERNAME;
    if (!username) {
        return;
    }
    await new Promise((resolve) => {
        const child = spawn("icacls", [
            resolvedPath,
            "/inheritance:r",
            "/grant:r",
            `${username}:R`,
        ], {
            stdio: "ignore",
            windowsHide: true,
        });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
    });
};
export const writeSecretFile = async (filePath, value, cwd) => {
    const expanded = expandHomePath(filePath);
    const resolved = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(cwd, expanded);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, value, "utf-8");
    try {
        await fs.chmod(resolved, 0o600);
    }
    catch {
        // Ignore permission failures.
    }
    try {
        await tightenWindowsAcl(resolved);
    }
    catch {
        // Ignore ACL hardening failures.
    }
    return resolved;
};
export const removeSecretFile = async (filePath) => {
    try {
        await fs.unlink(filePath);
    }
    catch {
        // Best-effort cleanup.
    }
};
