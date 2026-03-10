/**
 * Shared utilities for the tools system.
 */

import { promises as fs } from "fs";
import type { Dirent } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { createHash } from "crypto";

// Constants
export const MAX_OUTPUT = 30_000;
export const MAX_FILE_BYTES = 1_000_000;

const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|client[-_]?secret|session|csrf|x[-_]api[-_]key)/i;
const URL_SECRET_RE =
  /([?&](?:api[-_]?key|token|access_token|refresh_token|session|secret|password)=)([^&#\s]+)/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const BASIC_RE = /\b(Basic)\s+[A-Za-z0-9+/=]+\b/gi;
const COOKIE_INLINE_RE = /\b(cookie|set-cookie)\s*:\s*([^\n\r;]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const redactString = (input: string) =>
  input
    .replace(URL_SECRET_RE, "$1[REDACTED]")
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(BASIC_RE, "$1 [REDACTED]")
    .replace(COOKIE_INLINE_RE, "$1: [REDACTED]")
    .replace(JWT_RE, "[REDACTED]");

const sanitizeSensitiveData = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
    for (const [key, entry] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      output[key] = sanitizeSensitiveData(entry, depth + 1, seen);
    }
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSensitiveData(entry, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeSensitiveData(entry, depth + 1, seen);
  }
  return output;
};

export const log = (..._args: unknown[]) => {
  /* logging removed — use structured telemetry instead */
};
export const logError = (..._args: unknown[]) => {
  /* error logging removed — use structured telemetry instead */
};

export const sanitizeForLogs = (value: unknown) => sanitizeSensitiveData(value);

// Path utilities
export const ensureAbsolutePath = (filePath: string) => {
  if (!path.isAbsolute(filePath)) {
    return {
      ok: false as const,
      error: `file_path must be absolute. Received: ${filePath}`,
    };
  }
  return { ok: true as const };
};

export const toPosix = (value: string) => value.replace(/\\/g, "/");

export const expandHomePath = (value: string) => {
  const home = os.homedir();
  const userProfile = process.env.USERPROFILE || home;
  const localAppData =
    process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local");
  const appData =
    process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");
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
export const truncate = (value: string, max = MAX_OUTPUT) =>
  value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;

// Edit-diff utilities shared by the Stella runtime.
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// Directory utilities
export const isIgnoredDir = (name: string) =>
  name === "node_modules" ||
  name === ".git" ||
  name === "dist" ||
  name === "dist-electron" ||
  name === "release";

export const globToRegExp = (pattern: string) => {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") return "__STAR__";
      if (char === "?") return "__Q__";
      return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    })
    .join("");

  const withStars = escaped
    .replace(/__STAR____STAR__/g, ".*")
    .replace(/__STAR__/g, "[^/]*")
    .replace(/__Q__/g, ".");

  return new RegExp(`^${withStars}$`);
};

export const walkFiles = async (basePath: string) => {
  const results: string[] = [];
  const stack = [basePath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
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
export const readFileSafe = async (filePath: string) => {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ok: false as const,
      error: `File too large to read safely (${stat.size} bytes): ${filePath}`,
    };
  }
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { ok: true as const, content };
  } catch {
    const buffer = await fs.readFile(filePath);
    const base64 = buffer.toString("base64");
    return {
      ok: true as const,
      content: `[binary:${buffer.byteLength} bytes]\n${truncate(base64, 4000)}`,
    };
  }
};

export const formatWithLineNumbers = (content: string, offset = 1, limit = 2000) => {
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
export const stripHtml = (html: string) => {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// State utilities
export const getStatePath = (stateRoot: string, kind: string, id: string) =>
  path.join(stateRoot, kind, `${id}.json`);

export const loadJson = async <T>(filePath: string, fallback: T) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const saveJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
};

// Secret file utilities
const tightenWindowsAcl = async (resolvedPath: string) => {
  if (process.platform !== "win32") {
    return;
  }
  const username = process.env.USERNAME;
  if (!username) {
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(
      "icacls",
      [
        resolvedPath,
        "/inheritance:r",
        "/grant:r",
        `${username}:R`,
      ],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
};

const DEFAULT_SECRET_STATE_ROOT = path.resolve(process.cwd(), ".stella", "state");

const getSecretMountRecordsDir = (stateRoot?: string) =>
  path.join(stateRoot ?? DEFAULT_SECRET_STATE_ROOT, "secret_mounts", "records");

const removeFileIfExists = async (filePath: string) => {
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup.
  }
};

const fileExists = async (filePath: string) => {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const hashBuffer = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");

const hashString = (value: string) =>
  createHash("sha256").update(value, "utf-8").digest("hex");

type SecretMountRecord = {
  id: string;
  mountPath: string;
  backupPath?: string;
  recordPath: string;
  mountedHash: string;
  createdAt: number;
};

export type SecretFileMountHandle = {
  id: string;
  mountPath: string;
  backupPath?: string;
  recordPath: string;
  mountedHash: string;
};

const asSecretMountRecord = (value: unknown): SecretMountRecord | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.mountPath !== "string" ||
    typeof record.recordPath !== "string" ||
    typeof record.mountedHash !== "string" ||
    typeof record.createdAt !== "number"
  ) {
    return null;
  }
  if (record.backupPath !== undefined && typeof record.backupPath !== "string") {
    return null;
  }
  return {
    id: record.id,
    mountPath: record.mountPath,
    backupPath: record.backupPath as string | undefined,
    recordPath: record.recordPath,
    mountedHash: record.mountedHash,
    createdAt: record.createdAt,
  };
};

const restoreBackup = async (backupPath: string, mountPath: string) => {
  if (!(await fileExists(backupPath))) {
    return;
  }
  await fs.mkdir(path.dirname(mountPath), { recursive: true });
  await removeFileIfExists(mountPath);
  try {
    await fs.rename(backupPath, mountPath);
  } catch {
    // Fallback to copy+delete if rename cannot complete.
    await fs.copyFile(backupPath, mountPath);
    await removeFileIfExists(backupPath);
  }
};

export const writeSecretFile = async (
  filePath: string,
  value: string,
  cwd: string,
  stateRoot?: string,
): Promise<SecretFileMountHandle> => {
  const expanded = expandHomePath(filePath);
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(cwd, expanded);

  const mountId = crypto.randomUUID();
  const recordsDir = getSecretMountRecordsDir(stateRoot);
  const recordPath = path.join(recordsDir, `${mountId}.json`);
  const backupPath = `${resolved}.stella-backup-${mountId}`;
  const mountedHash = hashString(value);

  let hasBackup = false;

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.mkdir(recordsDir, { recursive: true });

    if (await fileExists(resolved)) {
      await removeFileIfExists(backupPath);
      await fs.rename(resolved, backupPath);
      hasBackup = true;
    }

    await fs.writeFile(resolved, value, "utf-8");
    try {
      await fs.chmod(resolved, 0o600);
    } catch {
      // Ignore permission failures.
    }
    try {
      await tightenWindowsAcl(resolved);
    } catch {
      // Ignore ACL hardening failures.
    }

    const record: SecretMountRecord = {
      id: mountId,
      mountPath: resolved,
      backupPath: hasBackup ? backupPath : undefined,
      recordPath,
      mountedHash,
      createdAt: Date.now(),
    };
    await saveJson(recordPath, record);

    return {
      id: mountId,
      mountPath: resolved,
      backupPath: hasBackup ? backupPath : undefined,
      recordPath,
      mountedHash,
    };
  } catch (error) {
    await removeFileIfExists(recordPath);
    await removeFileIfExists(resolved);
    if (hasBackup) {
      try {
        await restoreBackup(backupPath, resolved);
      } catch {
        // Best-effort rollback.
      }
    }
    throw error;
  }
};

export const removeSecretFile = async (mount: SecretFileMountHandle) => {
  const stored = asSecretMountRecord(
    await loadJson<unknown>(mount.recordPath, null),
  );
  const record = stored ?? {
    id: mount.id,
    mountPath: mount.mountPath,
    backupPath: mount.backupPath,
    recordPath: mount.recordPath,
    mountedHash: mount.mountedHash,
    createdAt: Date.now(),
  };

  await removeFileIfExists(record.mountPath);
  if (record.backupPath) {
    try {
      await restoreBackup(record.backupPath, record.mountPath);
    } catch {
      // Preserve backup file for manual recovery if restore fails.
    }
  }
  await removeFileIfExists(record.recordPath);
};

export const recoverStaleSecretFiles = async (stateRoot?: string) => {
  const recordsDir = getSecretMountRecordsDir(stateRoot);
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(recordsDir, { withFileTypes: true });
  } catch {
    return { recovered: 0, skipped: 0 };
  }

  let recovered = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const recordPath = path.join(recordsDir, entry.name);
    const stored = asSecretMountRecord(
      await loadJson<unknown>(recordPath, null),
    );
    if (!stored) {
      await removeFileIfExists(recordPath);
      continue;
    }

    const mountExists = await fileExists(stored.mountPath);
    const backupExists = stored.backupPath
      ? await fileExists(stored.backupPath)
      : false;

    if (mountExists) {
      try {
        const currentBytes = await fs.readFile(stored.mountPath);
        const currentHash = hashBuffer(currentBytes);
        if (currentHash !== stored.mountedHash) {
          skipped += 1;
          continue;
        }
      } catch {
        skipped += 1;
        continue;
      }
    }

    await removeFileIfExists(stored.mountPath);
    if (backupExists && stored.backupPath) {
      try {
        await restoreBackup(stored.backupPath, stored.mountPath);
      } catch {
        skipped += 1;
        continue;
      }
    }

    await removeFileIfExists(recordPath);
    recovered += 1;
  }
  return { recovered, skipped };
};
