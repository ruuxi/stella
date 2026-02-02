/**
 * Shell History Analysis
 *
 * Extracts actual tool usage patterns and project paths from shell history.
 * High signal: what they actually run, not what's installed.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";

import type { ShellAnalysis, CommandFrequency } from "./types.js";

const log = (...args: unknown[]) => console.log("[shell-history]", ...args);

// ---------------------------------------------------------------------------
// Platform Paths
// ---------------------------------------------------------------------------

const getHistoryPaths = (): string[] => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [
      // PowerShell history
      path.join(appData, "Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),
      // Git Bash history (if they use it)
      path.join(home, ".bash_history"),
    ];
  }

  // macOS / Linux
  return [
    path.join(home, ".zsh_history"),
    path.join(home, ".bash_history"),
  ];
};

// ---------------------------------------------------------------------------
// Sensitive Pattern Filters
// ---------------------------------------------------------------------------

// Commands that might contain sensitive data - skip these entirely
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth/i,
  /credential/i,
  /--password/i,
  /-p\s+\S+/i, // -p flag often used for passwords
  /export\s+\w*(KEY|TOKEN|SECRET|PASSWORD)/i,
  /curl.*-H.*Authorization/i,
  /curl.*-u\s/i,
];

const isSensitiveCommand = (line: string): boolean => {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(line));
};

// ---------------------------------------------------------------------------
// Dev Tools Detection
// ---------------------------------------------------------------------------

// Tools we care about tracking (dev-related)
const DEV_TOOLS = new Set([
  "git",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "node",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "cargo",
  "rustc",
  "go",
  "docker",
  "docker-compose",
  "kubectl",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "code",
  "cursor",
  "vim",
  "nvim",
  "nano",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "dotnet",
  "ruby",
  "gem",
  "bundle",
  "php",
  "composer",
  "java",
  "javac",
  "scala",
  "sbt",
  "swift",
  "xcodebuild",
  "flutter",
  "dart",
  "zig",
]);

// ---------------------------------------------------------------------------
// History Parsing
// ---------------------------------------------------------------------------

/**
 * Parse zsh extended history format
 * Format: : timestamp:0;command
 */
const parseZshLine = (line: string): string | null => {
  if (line.startsWith(": ")) {
    // Extended format: : timestamp:0;command
    const semicolonIdx = line.indexOf(";");
    if (semicolonIdx !== -1) {
      return line.slice(semicolonIdx + 1).trim();
    }
  }
  return line.trim();
};

/**
 * Extract the base command (first word) from a command line
 */
const extractBaseCommand = (line: string): string | null => {
  // Skip empty lines and comments
  if (!line || line.startsWith("#")) return null;

  // Handle common prefixes
  let cmd = line.trim();

  // Strip sudo, env vars, time, etc.
  cmd = cmd.replace(/^(sudo|time|nohup|nice|env\s+\S+=\S+\s*)+/i, "").trim();

  // Get first word
  const match = cmd.match(/^([a-zA-Z0-9_.-]+)/);
  return match ? match[1].toLowerCase() : null;
};

/**
 * Check if a path looks valid (not URL-encoded, not malformed)
 */
const isValidPath = (p: string): boolean => {
  // Reject URL-encoded paths (contain %XX)
  if (/%[0-9A-Fa-f]{2}/.test(p)) return false;

  // Reject paths that look like /x:/... (malformed git-bash style)
  // Valid: /c/Users/... or C:\Users\...
  // Invalid: /u:/apps/... (colon after single letter in unix-style path)
  if (/^\/[a-zA-Z]:/.test(p)) return false;

  // Reject paths with unusual characters that suggest corruption
  if (/[\x00-\x1F]/.test(p)) return false;

  return true;
};

/**
 * Extract path from cd commands
 * Handles command chains (&&, ||, ;, |) and redirections (>, <)
 */
const extractCdPath = (line: string): string | null => {
  const cdMatch = line.match(/^\s*cd\s+(.+)$/);
  if (!cdMatch) return null;

  let cdPath = cdMatch[1].trim();

  // Strip command chains and redirections
  // Stop at: &&, ||, ;, |, >, <, or end of string
  // Handle both quoted and unquoted paths
  const chainMatch = cdPath.match(/^(?:"([^"]+)"|'([^']+)'|([^\s&|;><]+))/);
  if (chainMatch) {
    cdPath = chainMatch[1] || chainMatch[2] || chainMatch[3] || "";
  }

  cdPath = cdPath.trim();

  // Remove any remaining quotes
  cdPath = cdPath.replace(/^["']|["']$/g, "");

  // Skip special cd targets
  if (cdPath === "-" || cdPath === ".." || cdPath === "." || cdPath === "") return null;

  // Validate path format
  if (!isValidPath(cdPath)) return null;

  // Expand ~ to home
  if (cdPath.startsWith("~")) {
    cdPath = cdPath.replace(/^~/, os.homedir());
  }

  // Skip very short paths (likely relative like ".", "..", "a")
  if (cdPath.length < 3) return null;

  // Only keep paths that look like project directories
  // (contain letters and are reasonably long)
  if (cdPath.length < 5 && !path.isAbsolute(cdPath)) return null;

  return cdPath;
};

// ---------------------------------------------------------------------------
// Main Analysis
// ---------------------------------------------------------------------------

export const analyzeShellHistory = async (): Promise<ShellAnalysis> => {
  log("Starting shell history analysis...");

  const historyPaths = getHistoryPaths();
  const commandCounts = new Map<string, number>();
  const projectPathCounts = new Map<string, number>();
  const toolsFound = new Set<string>();

  for (const historyPath of historyPaths) {
    try {
      const content = await fs.readFile(historyPath, "utf-8");
      const lines = content.split("\n");

      log(`Parsing ${historyPath}: ${lines.length} lines`);

      for (const rawLine of lines) {
        // Parse line (handle zsh extended format)
        const line = parseZshLine(rawLine);
        if (!line) continue;

        // Skip sensitive commands
        if (isSensitiveCommand(line)) continue;

        // Extract base command
        const baseCmd = extractBaseCommand(line);
        if (baseCmd) {
          commandCounts.set(baseCmd, (commandCounts.get(baseCmd) || 0) + 1);

          // Track dev tools
          if (DEV_TOOLS.has(baseCmd)) {
            toolsFound.add(baseCmd);
          }
        }

        // Extract cd paths
        const cdPath = extractCdPath(line);
        if (cdPath) {
          projectPathCounts.set(cdPath, (projectPathCounts.get(cdPath) || 0) + 1);
        }
      }
    } catch {
      // History file doesn't exist or can't be read
      continue;
    }
  }

  // Sort commands by frequency, take top 30
  const topCommands: CommandFrequency[] = Array.from(commandCounts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // Sort project paths by frequency, take top 20
  const projectPaths = Array.from(projectPathCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([p]) => p);

  // Sort tools alphabetically
  const toolsUsed = Array.from(toolsFound).sort();

  log("Analysis complete:", {
    topCommands: topCommands.length,
    projectPaths: projectPaths.length,
    toolsUsed: toolsUsed.length,
  });

  return {
    topCommands,
    projectPaths,
    toolsUsed,
  };
};

/**
 * Format shell analysis for LLM synthesis
 */
export const formatShellAnalysisForSynthesis = (data: ShellAnalysis): string => {
  const sections: string[] = ["## Shell History"];

  if (data.toolsUsed.length > 0) {
    sections.push("\n### Dev Tools Used");
    sections.push(data.toolsUsed.join(", "));
  }

  if (data.topCommands.length > 0) {
    // Filter to dev-relevant commands for synthesis
    const devCommands = data.topCommands
      .filter((c) => DEV_TOOLS.has(c.command))
      .slice(0, 15);

    if (devCommands.length > 0) {
      sections.push("\n### Command Frequency");
      sections.push(devCommands.map((c) => `${c.command} (${c.count})`).join(", "));
    }
  }

  if (data.projectPaths.length > 0) {
    sections.push("\n### Working Directories");
    sections.push(data.projectPaths.slice(0, 10).join("\n"));
  }

  return sections.join("\n");
};
