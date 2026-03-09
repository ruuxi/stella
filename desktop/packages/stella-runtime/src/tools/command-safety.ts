/**
 * Security hardening utilities for the local tool system.
 *
 * - isDangerousCommand(): blocklist of destructive shell commands
 * - isBlockedPath(): system directory path guard for file operations
 */

import path from "path";
import os from "os";
import { getDangerousCommandReason } from "./schemas.js";

// ---------------------------------------------------------------------------
// 1. Dangerous Command Blocklist
// ---------------------------------------------------------------------------

// NOTE: Normal rm/del operations are handled by the deferred-delete trash system
// (see deferred-delete.ts + buildProtectedCommand in tools-shell.ts) which intercepts
// rm/rmdir/unlink/del/erase and moves files to ~/.stella/state/deferred-delete/trash/
// with 24h retention. The blocklist here only catches things the trash CAN'T protect
// against: filesystem-level destruction, fork bombs, and system power commands.

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
const BLOCKED_PATH_PREFIXES: string[] = (() => {
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

/**
 * Normalize a path for comparison: resolve, lower-case, forward slashes.
 */
const normalizePath = (filePath: string): string => {
  // Expand ~ to home dir
  const expanded = filePath.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  return resolved.replace(/\\/g, "/").toLowerCase();
};

/**
 * Check if a file path targets a blocked system directory.
 * Returns `null` if allowed, or an error message if blocked.
 */
export const isBlockedPath = (filePath: string): string | null => {
  const normalized = normalizePath(filePath);

  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")) {
      return "Path blocked: file operations in system directories are not allowed for safety.";
    }
  }

  return null;
};
