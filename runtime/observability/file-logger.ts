import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { resolveLogPaths } from "./log-paths.js";
import { scrubFieldValue, scrubText } from "./scrub.js";

/**
 * Local-only, privacy-scrubbed diagnostic logger shared by every Stella
 * process (Electron main and the Bun runtime worker).
 *
 * Goals:
 *   - Capture errors/crashes and process lifecycle (workers + native
 *     helpers starting / being cleaned up) to plain `.txt` files.
 *   - Daily rotation with automatic retention cleanup.
 *   - Never write private data: the API takes structured metadata only,
 *     and everything that reaches disk is scrubbed (see `scrub.ts`).
 *
 * Writes are synchronous `appendFileSync`. Diagnostic volume is low
 * (lifecycle transitions + errors), so the cost is negligible, and sync
 * writes guarantee the line lands on disk even if the process is mid-crash
 * — which is exactly when these logs matter most. Do NOT route hot-path /
 * per-token / per-frame logging through here.
 */

export type LogChannel = "error" | "process";
export type LogLevel = "info" | "warn" | "error" | "fatal";
export type LogFields = Record<string, unknown>;

const DEFAULT_RETENTION_DAYS = 7;
// Soft per-file cap so a crash loop can't fill the disk within a single
// day. Once a day's file passes this we stop appending to it (a single
// truncation marker is written once); it resets at the next daily rollover.
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
// Total budget across every log file in the directory. Enforced on the
// age sweep (init + daily rollover): oldest files are deleted first until
// the directory is back under budget. Bounds long-term accumulation
// independent of the day-count retention window.
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const LOG_FILE_PATTERN = /^(error|process)-\d{4}-\d{2}-\d{2}\.txt$/;

const dateStamp = (now: Date): string => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export type FileLoggerOptions = {
  /** Absolute directory the log files live in. */
  logDir: string;
  /** Identifies the writing process, e.g. "main" or "worker". */
  component: string;
  /** Delete files older than this many days. */
  retentionDays?: number;
  /** Stop appending to a single day's file once it passes this size. */
  maxFileBytes?: number;
  /** Total byte budget across all log files; oldest are deleted first. */
  maxTotalBytes?: number;
};

export class FileLogger {
  private readonly logDir: string;
  private readonly component: string;
  private readonly retentionDays: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private currentStamp = "";
  private dirReady = false;
  private readonly truncatedChannels = new Set<LogChannel>();

  constructor(options: FileLoggerOptions) {
    this.logDir = options.logDir;
    this.component = options.component;
    this.retentionDays =
      options.retentionDays ??
      parsePositiveInt(
        process.env.STELLA_LOG_RETENTION_DAYS,
        DEFAULT_RETENTION_DAYS,
      );
    this.maxFileBytes =
      options.maxFileBytes ??
      parsePositiveInt(
        process.env.STELLA_LOG_MAX_FILE_BYTES,
        DEFAULT_MAX_FILE_BYTES,
      );
    this.maxTotalBytes =
      options.maxTotalBytes ??
      parsePositiveInt(
        process.env.STELLA_LOG_MAX_TOTAL_BYTES,
        DEFAULT_MAX_TOTAL_BYTES,
      );
  }

  /** Lifecycle / process event (worker + native helper start/stop/cleanup). */
  process(event: string, fields?: LogFields): void {
    this.write("process", "info", event, fields);
  }

  /** Non-fatal warning routed to the process channel. */
  warn(event: string, fields?: LogFields): void {
    this.write("process", "warn", event, fields);
  }

  /** Recoverable error. */
  error(event: string, fields?: LogFields): void {
    this.write("error", "error", event, fields);
  }

  /** Crash / fatal error with a (scrubbed) stack trace. */
  crash(event: string, error: unknown, fields?: LogFields): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ? scrubText(err.stack) : undefined;
    this.write("error", "fatal", event, {
      ...fields,
      errorName: err.name,
      errorMessage: err.message,
      ...(stack ? { stack } : {}),
    });
  }

  private ensureDir(): boolean {
    if (this.dirReady) return true;
    try {
      mkdirSync(this.logDir, { recursive: true });
      this.dirReady = true;
    } catch {
      // If we can't create the log dir, diagnostics silently no-op rather
      // than break the app.
      this.dirReady = false;
    }
    return this.dirReady;
  }

  private rollIfNeeded(now: Date): void {
    const stamp = dateStamp(now);
    if (stamp === this.currentStamp) return;
    this.currentStamp = stamp;
    this.truncatedChannels.clear();
    this.sweepRetention(now);
  }

  private filePath(channel: LogChannel): string {
    return path.join(this.logDir, `${channel}-${this.currentStamp}.txt`);
  }

  private sweepRetention(now: Date): void {
    let remaining: Array<{ filePath: string; size: number; mtimeMs: number }>;
    try {
      const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
      remaining = [];
      for (const name of readdirSync(this.logDir)) {
        if (!LOG_FILE_PATTERN.test(name)) continue;
        const filePath = path.join(this.logDir, name);
        try {
          const stat = statSync(filePath);
          // Age-based retention first.
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
            continue;
          }
          remaining.push({
            filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // Skip files we can't stat/unlink.
        }
      }
    } catch {
      // Directory may not exist yet; nothing to sweep.
      return;
    }

    // Total-size budget: delete oldest files first until under budget.
    // The active (newest) file is preserved so we never delete what we're
    // about to append to.
    let total = remaining.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.maxTotalBytes) return;
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (let i = 0; i < remaining.length - 1 && total > this.maxTotalBytes; i++) {
      const entry = remaining[i];
      if (!entry) continue;
      try {
        unlinkSync(entry.filePath);
        total -= entry.size;
      } catch {
        // Skip files we can't unlink.
      }
    }
  }

  private isOverSizeCap(filePath: string): boolean {
    try {
      return statSync(filePath).size >= this.maxFileBytes;
    } catch {
      return false;
    }
  }

  private write(
    channel: LogChannel,
    level: LogLevel,
    event: string,
    fields?: LogFields,
  ): void {
    if (!this.ensureDir()) return;
    const now = new Date();
    this.rollIfNeeded(now);
    const filePath = this.filePath(channel);

    if (this.truncatedChannels.has(channel)) return;
    if (this.isOverSizeCap(filePath)) {
      this.truncatedChannels.add(channel);
      try {
        appendFileSync(
          filePath,
          `${now.toISOString()} [warn] [${this.component}] log.truncated reason=size-cap\n`,
        );
      } catch {
        // ignore
      }
      return;
    }

    const line = this.format(now, level, event, fields);
    try {
      appendFileSync(filePath, line);
    } catch {
      // Best-effort diagnostics; never throw from a logging call.
    }
  }

  private format(
    now: Date,
    level: LogLevel,
    event: string,
    fields?: LogFields,
  ): string {
    const parts = [
      now.toISOString(),
      `[${level}]`,
      `[${this.component}]`,
      scrubText(event),
    ];
    let stack: string | undefined;
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (key === "stack") {
          stack = typeof value === "string" ? value : String(value);
          continue;
        }
        const rendered = scrubFieldValue(value);
        parts.push(`${key}=${rendered.includes(" ") ? `"${rendered}"` : rendered}`);
      }
    }
    let line = `${parts.join(" ")}\n`;
    if (stack) {
      // Always scrub the stack block — callers may pass an unscrubbed stack
      // as a field (e.g. renderer errors via `error()`), and stacks routinely
      // embed the error message which can carry secrets.
      line += `${scrubText(stack)
        .split("\n")
        .map((s) => `    ${s.trim()}`)
        .join("\n")}\n`;
    }
    return line;
  }
}

let sharedLogger: FileLogger | null = null;

/**
 * Initialize (or return the existing) per-process diagnostic logger.
 * Idempotent: a process should call this once at startup; later callers
 * reuse the same instance.
 */
export const initFileLogger = (
  stellaAppDir: string,
  component: string,
  options?: { retentionDays?: number },
): FileLogger => {
  if (sharedLogger) return sharedLogger;
  const { logDir } = resolveLogPaths(stellaAppDir);
  sharedLogger = new FileLogger({
    logDir,
    component,
    ...(options?.retentionDays != null
      ? { retentionDays: options.retentionDays }
      : {}),
  });
  return sharedLogger;
};

/**
 * Get the process-wide logger if it has been initialized. Returns null
 * before `initFileLogger` runs so call sites can no-op safely.
 */
export const getFileLogger = (): FileLogger | null => sharedLogger;

/**
 * Install global crash handlers that route uncaught exceptions and
 * unhandled rejections to the error channel before the runtime acts on them.
 *
 * For uncaught exceptions we use `uncaughtExceptionMonitor`, which observes
 * the error and writes a durable on-disk record WITHOUT suppressing the
 * runtime's default fatal behavior (the process still crashes/exits as
 * Node/Bun/Electron would without this listener). A plain `uncaughtException`
 * listener would silently swallow the crash and leave the process running in
 * an undefined state.
 *
 * For unhandled rejections we register an `unhandledRejection` listener, which
 * DOES swallow the rejection (the process keeps running with only a log line)
 * rather than triggering the default surfacing. This is deliberate: the
 * detached worker relies on it to stay alive across benign unhandled
 * rejections. Callers that want strict fatal semantics here should revisit
 * this decision.
 */
export const installGlobalErrorLogging = (logger: FileLogger): void => {
  process.on("uncaughtExceptionMonitor", (error) => {
    logger.crash("process.uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    logger.crash("process.unhandledRejection", reason);
  });
};
