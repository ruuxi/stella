/**
 * Security hardening utilities for the local tool system.
 *
 * - isDangerousCommand(): blocklist of destructive shell commands
 * - isBlockedPath(): system directory path guard for file operations
 * - validateSkillContent(): scans skill markdown for unsafe patterns
 */
import path from "path";
import os from "os";
// ---------------------------------------------------------------------------
// 1. Dangerous Command Blocklist
// ---------------------------------------------------------------------------
const DANGEROUS_COMMAND_PATTERNS = [
    // Recursive force-delete of root or home
    { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?|(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*\s+)[/"']?\s*\/\s*$/i, reason: "rm -rf /" },
    { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/i, reason: "rm -rf /" },
    { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i, reason: "rm -rf /" },
    { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i, reason: "rm -rf /" },
    { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i, reason: "rm -rf ~" },
    { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i, reason: "rm -rf ~" },
    // Windows destructive commands
    { pattern: /\bdel\s+\/[fF]\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/i, reason: "del /f /s /q C:\\" },
    { pattern: /\bformat\s+[a-zA-Z]:\s*/i, reason: "format drive" },
    // Disk/filesystem destruction
    { pattern: /\bdd\s+if=/i, reason: "dd if= (raw disk write)" },
    { pattern: /\bmkfs\b/i, reason: "mkfs (format filesystem)" },
    // Fork bomb
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, reason: "fork bomb" },
    // System power commands
    { pattern: /\bshutdown\b/i, reason: "shutdown" },
    { pattern: /\breboot\b/i, reason: "reboot" },
    // System directory targeting — catch commands that operate on system dirs
    { pattern: /\brm\s+.*\/etc\b/i, reason: "targeting /etc" },
    { pattern: /\brm\s+.*\/usr\b/i, reason: "targeting /usr" },
    { pattern: /\brm\s+.*\/bin\b/i, reason: "targeting /bin" },
    { pattern: /\brm\s+.*\/sbin\b/i, reason: "targeting /sbin" },
    { pattern: /\brm\s+.*\/boot\b/i, reason: "targeting /boot" },
    { pattern: /\brm\s+.*[cC]:\\Windows\b/i, reason: "targeting C:\\Windows" },
    { pattern: /\brm\s+.*[cC]:\\Program\s+Files\b/i, reason: "targeting C:\\Program Files" },
    { pattern: /\bSystem32\b.*\b(del|rm|rmdir|erase|rd)\b/i, reason: "targeting System32" },
    { pattern: /\b(del|rm|rmdir|erase|rd)\b.*\bSystem32\b/i, reason: "targeting System32" },
];
/**
 * Check if a command string contains dangerous/destructive patterns.
 * Returns `null` if safe, or a reason string if blocked.
 */
export const isDangerousCommand = (command) => {
    for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(command)) {
            return reason;
        }
    }
    return null;
};
// ---------------------------------------------------------------------------
// 2. Workspace Path Guards
// ---------------------------------------------------------------------------
/**
 * Normalized list of blocked system directory prefixes.
 * All comparisons are done case-insensitively with forward slashes.
 */
const BLOCKED_PATH_PREFIXES = (() => {
    const prefixes = [
        // Unix system directories
        "/etc/",
        "/etc",
        "/usr/",
        "/usr",
        "/bin/",
        "/bin",
        "/sbin/",
        "/sbin",
        "/boot/",
        "/boot",
        "/sys/",
        "/sys",
        "/proc/",
        "/proc",
    ];
    // Windows system directories — normalized with forward slashes
    if (process.platform === "win32") {
        prefixes.push("c:/windows/", "c:/windows", "c:/program files/", "c:/program files", "c:/program files (x86)/", "c:/program files (x86)");
        // Also catch the System32 directory specifically
        prefixes.push("c:/windows/system32/", "c:/windows/system32");
    }
    return prefixes;
})();
/**
 * Normalize a path for comparison: resolve, lower-case, forward slashes.
 */
const normalizePath = (filePath) => {
    // Expand ~ to home dir
    const expanded = filePath.replace(/^~(?=$|[\\/])/, os.homedir());
    const resolved = path.resolve(expanded);
    return resolved.replace(/\\/g, "/").toLowerCase();
};
/**
 * Check if a file path targets a blocked system directory.
 * Returns `null` if allowed, or an error message if blocked.
 */
export const isBlockedPath = (filePath) => {
    const normalized = normalizePath(filePath);
    for (const prefix of BLOCKED_PATH_PREFIXES) {
        if (normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")) {
            return "Path blocked: file operations in system directories are not allowed for safety.";
        }
    }
    return null;
};
/**
 * Strip fenced code blocks from content so we don't flag legitimate code examples.
 * We still want to check inline backtick commands and $() outside of code blocks.
 */
const stripCodeBlocks = (content) => {
    // Remove fenced code blocks (``` ... ```)
    return content.replace(/```[\s\S]*?```/g, "[CODE_BLOCK]");
};
const UNSAFE_SKILL_PATTERNS = [
    // Shell injection attempts (outside code blocks)
    {
        pattern: /`[^`]*(?:curl|wget|nc|ncat)\s+[^`]*`/i,
        category: "shell_injection",
        description: "Backtick command with network tool",
    },
    {
        pattern: /\$\([^)]*(?:curl|wget|nc|ncat)\s+[^)]*\)/i,
        category: "shell_injection",
        description: "Command substitution with network tool",
    },
    // Credential exfiltration patterns
    {
        pattern: /\bcurl\b[^;\n]*\$[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)\b/i,
        category: "credential_exfiltration",
        description: "curl with credential variable",
    },
    {
        pattern: /\becho\b[^;\n]*\$[A-Z_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)\b/i,
        category: "credential_exfiltration",
        description: "echo of credential variable",
    },
    {
        pattern: /\bsend\b[^;\n]*\bcredentials?\b/i,
        category: "credential_exfiltration",
        description: "sending credentials",
    },
    {
        pattern: /\bexfiltrate\b/i,
        category: "credential_exfiltration",
        description: "exfiltration keyword",
    },
    {
        pattern: /\bbase64\s+encode\b[^;\n]*\bkey\b/i,
        category: "credential_exfiltration",
        description: "base64 encoding a key",
    },
    // Prompt override attempts
    {
        pattern: /\bignore\s+previous\s+instructions\b/i,
        category: "prompt_override",
        description: "ignore previous instructions",
    },
    {
        pattern: /\bignore\s+all\s+prior\b/i,
        category: "prompt_override",
        description: "ignore all prior instructions",
    },
    {
        pattern: /\byou\s+are\s+now\b/i,
        category: "prompt_override",
        description: "identity override attempt",
    },
    {
        pattern: /\bnew\s+system\s+prompt\b/i,
        category: "prompt_override",
        description: "system prompt injection",
    },
    {
        pattern: /\bdisregard\s+your\s+instructions\b/i,
        category: "prompt_override",
        description: "disregard instructions",
    },
    // Data exfiltration URLs
    {
        pattern: /\bwebhook\.site\b/i,
        category: "exfiltration_url",
        description: "webhook.site URL",
    },
    {
        pattern: /\brequestbin\b/i,
        category: "exfiltration_url",
        description: "requestbin URL",
    },
    {
        pattern: /\bngrok\.io\b/i,
        category: "exfiltration_url",
        description: "ngrok.io URL",
    },
    {
        pattern: /\bburpcollaborator\b/i,
        category: "exfiltration_url",
        description: "burpcollaborator URL",
    },
];
/**
 * Validate skill markdown content for unsafe patterns.
 * Returns a result indicating whether the content is safe and what issues were found.
 */
export const validateSkillContent = (content) => {
    const strippedContent = stripCodeBlocks(content);
    const issues = [];
    for (const { pattern, category, description } of UNSAFE_SKILL_PATTERNS) {
        if (pattern.test(strippedContent)) {
            issues.push({ category, description });
        }
    }
    return {
        safe: issues.length === 0,
        issues,
    };
};
