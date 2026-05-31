/**
 * Security hardening utilities for the local tool system.
 *
 * - isDangerousCommand(): blocklist of destructive shell commands
 * - isBlockedPath(): system directory path guard for file operations
 */

import path from "path";
import os from "os";
import { getDangerousCommandReason } from "./schemas.js";
import { resolveHomeRelative } from "./safety.js";

// ---------------------------------------------------------------------------
// 1. Dangerous Command Blocklist
// ---------------------------------------------------------------------------

// NOTE: Normal delete operations are handled by the deferred-delete trash system
// (see deferred-delete.ts + shell.ts): macOS/Linux shells intercept rm/rmdir/unlink
// through the shell preamble, and Windows native delete commands are routed through
// the same trash helper before cmd.exe starts. The blocklist here catches things
// the trash can't protect against: filesystem-level destruction, fork bombs, and
// system power commands.

/**
 * Check if a command string contains dangerous/destructive patterns.
 * Returns `null` if safe, or a reason string if blocked.
 */
export const isDangerousCommand = getDangerousCommandReason;

// ---------------------------------------------------------------------------
// 2. Workspace Path Guards
// ---------------------------------------------------------------------------

/**
 * Normalized list of blocked system directory prefixes.
 * All comparisons are done case-insensitively with forward slashes.
 */
const BLOCKED_WRITE_PATH_PREFIXES: string[] = (() => {
  const prefixes: string[] = [
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
    "/private/etc/",
    "/private/etc",
    "/private/var/",
    "/private/var",
    path.join(os.homedir(), ".ssh"),
    path.join(os.homedir(), ".aws"),
    path.join(os.homedir(), ".gnupg"),
    path.join(os.homedir(), ".kube"),
    path.join(os.homedir(), ".docker"),
    path.join(os.homedir(), ".azure"),
    path.join(os.homedir(), ".config", "gh"),
    path.join(os.homedir(), ".config", "gcloud"),
  ];

  // Windows system directories — normalized with forward slashes
  if (typeof process !== "undefined" && process.platform === "win32") {
    prefixes.push(
      "c:/windows/",
      "c:/windows",
      "c:/program files/",
      "c:/program files",
      "c:/program files (x86)/",
      "c:/program files (x86)",
    );

    // Also catch the System32 directory specifically
    prefixes.push("c:/windows/system32/", "c:/windows/system32");
  }

  return prefixes;
})();

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/console",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

const SENSITIVE_HOME_FILES = [
  ".ssh/authorized_keys",
  ".ssh/id_rsa",
  ".ssh/id_ed25519",
  ".ssh/config",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".bash_profile",
  ".zprofile",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
];

const STELLA_CREDENTIAL_FILES = [
  ".env",
  "auth.json",
  "auth.lock",
  "config.json",
  "preferences.json",
  "connectors/.credentials.json",
];

/**
 * Normalize a path for comparison: resolve, lower-case, forward slashes.
 */
const normalizePath = (filePath: string): string => {
  // Expand ~ to home dir
  const expanded = resolveHomeRelative(filePath);
  const resolved = path.resolve(expanded);
  return resolved.replace(/\\/g, "/").toLowerCase();
};

const normalizePrefix = (prefix: string): string =>
  normalizePath(prefix).replace(/\/+$/u, "");

const pathMatchesPrefix = (normalized: string, prefix: string): boolean => {
  const normalizedPrefix = normalizePrefix(prefix);
  return (
    normalized === normalizedPrefix ||
    normalized.startsWith(`${normalizedPrefix}/`)
  );
};

const stellaHomesForContext = (context?: {
  stellaHome?: string;
  stellaRoot?: string;
}): string[] => {
  const homes = [
    context?.stellaHome,
    process.env.STELLA_HOME,
    path.join(os.homedir(), ".stella"),
    context?.stellaRoot,
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  return [...new Set(homes.map((entry) => path.resolve(entry)))];
};

const isBlockedDevice = (normalized: string): boolean => {
  if (BLOCKED_DEVICE_PATHS.has(normalized)) return true;
  return /^\/proc\/\d+\/fd\/[0-2]$/u.test(normalized);
};

const isSensitiveHomePath = (normalized: string): boolean => {
  for (const rel of SENSITIVE_HOME_FILES) {
    if (normalized === normalizePath(path.join(os.homedir(), rel))) {
      return true;
    }
  }
  return false;
};

const isSensitiveStellaPath = (
  normalized: string,
  context?: { stellaHome?: string; stellaRoot?: string },
): boolean => {
  for (const home of stellaHomesForContext(context)) {
    for (const rel of STELLA_CREDENTIAL_FILES) {
      if (normalized === normalizePath(path.join(home, rel))) {
        return true;
      }
    }
    for (const rel of ["mcp-tokens", "pairing", "skills/.hub"]) {
      if (pathMatchesPrefix(normalized, path.join(home, rel))) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Check if a file path targets a blocked system directory.
 * Returns `null` if allowed, or an error message if blocked.
 */
export const isBlockedPath = (
  filePath: string,
  context?: { stellaHome?: string; stellaRoot?: string },
): string | null => {
  const normalized = normalizePath(filePath);

  if (isBlockedDevice(normalized)) {
    return "Path blocked: device files that can block or produce infinite output are not available to file tools.";
  }

  if (
    isSensitiveHomePath(normalized) ||
    isSensitiveStellaPath(normalized, context)
  ) {
    return "Path blocked: credential, token, or internal Stella state files are not available to file tools.";
  }

  for (const prefix of BLOCKED_WRITE_PATH_PREFIXES) {
    if (pathMatchesPrefix(normalized, prefix)) {
      return "Path blocked: file operations in system directories are not allowed for safety.";
    }
  }

  return null;
};
