/**
 * Shared UI state store — owns `~/.stella/ui-state.json`, the renderer's
 * durable key/value state (formerly per-origin localStorage).
 *
 * Two hosts run an instance of this store against the same file at once: the
 * Electron main process and the Vite dev server (for plain-browser tabs).
 * Convergence model:
 *   - Writes are per-key read-merge-write: a flush re-reads the file and
 *     applies only this host's pending deltas on top, so concurrent hosts
 *     converge last-write-wins per key instead of clobbering whole maps.
 *   - Each host watches the file and emits external diffs to its renderers.
 *     Self-writes never emit: after a flush the file equals memory, so the
 *     watcher's diff is empty (content-based suppression, no timing games).
 */

import fs from "fs";
import path from "path";
import { ensurePrivateDirSync } from "../shared/private-fs.js";
import {
  UI_STATE_FILE_NAME,
  type UiStateChanges,
  type UiStateSnapshot,
} from "../../contracts/ui-state.js";

const FLUSH_DEBOUNCE_MS = 150;
const WATCH_DEBOUNCE_MS = 50;
const PRIVATE_FILE_MODE = 0o600;

const readUiStateFile = (filePath: string): Map<string, string> => {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return new Map();
    }
    const state = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        state.set(key, value);
      }
    }
    return state;
  } catch {
    return new Map();
  }
};

export class UiStateStore {
  private readonly filePath: string;
  private readonly memory: Map<string, string>;
  private readonly pending = new Map<string, string | null>();
  private pendingClear = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(changes: UiStateChanges) => void>();
  private disposed = false;

  constructor(stellaDataDir: string) {
    this.filePath = path.join(stellaDataDir, UI_STATE_FILE_NAME);
    ensurePrivateDirSync(path.dirname(this.filePath));
    this.memory = readUiStateFile(this.filePath);
    this.startWatcher();
  }

  snapshot(): UiStateSnapshot {
    return Object.fromEntries(this.memory);
  }

  get(key: string): string | null {
    return this.memory.get(key) ?? null;
  }

  /**
   * Applies a batch of changes (null = remove). Returns the subset that
   * actually changed in-memory state, for broadcasting to renderers.
   */
  apply(changes: UiStateChanges): UiStateChanges {
    const applied: UiStateChanges = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        if (!this.memory.has(key)) continue;
        this.memory.delete(key);
      } else {
        if (this.memory.get(key) === value) continue;
        this.memory.set(key, value);
      }
      this.pending.set(key, value);
      applied[key] = value;
    }
    if (Object.keys(applied).length > 0) {
      this.scheduleFlush();
    }
    return applied;
  }

  /** Removes every key. Returns the removal change set for broadcasting. */
  clear(): UiStateChanges {
    const removed: UiStateChanges = {};
    for (const key of this.memory.keys()) {
      removed[key] = null;
    }
    this.memory.clear();
    this.pending.clear();
    this.pendingClear = true;
    this.scheduleFlush();
    return removed;
  }

  /** Listener for changes written by another host (or another process). */
  onExternalChange(listener: (changes: UiStateChanges) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Synchronously persists pending deltas (shutdown path). */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingClear && this.pending.size === 0) return;
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.flushSync();
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    fs.unwatchFile(this.filePath);
    this.listeners.clear();
  }

  private scheduleFlush() {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush() {
    // Read-merge-write: start from the file's current state (another host
    // may have flushed since our last read) unless this flush carries a
    // clear, then layer only our pending deltas on top.
    const next = this.pendingClear
      ? new Map<string, string>()
      : readUiStateFile(this.filePath);
    for (const [key, value] of this.pending) {
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    this.pending.clear();
    this.pendingClear = false;

    try {
      this.writeAtomic(next);
    } catch (error) {
      console.warn(
        "[ui-state] Failed to persist ui-state.json:",
        (error as Error).message,
      );
      return;
    }

    // The merge may have pulled in another host's keys; sync memory to the
    // written state and surface those external diffs to our renderers.
    this.reconcileMemory(next);
  }

  private writeAtomic(state: Map<string, string>) {
    const tmpPath = `${this.filePath}.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    const body = JSON.stringify(Object.fromEntries(state), null, 2);
    fs.writeFileSync(tmpPath, body, {
      encoding: "utf-8",
      mode: PRIVATE_FILE_MODE,
    });
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  /**
   * Syncs memory to `next` (the authoritative on-disk state plus our pending
   * deltas) and emits the diff. Self-writes produce an empty diff.
   */
  private reconcileMemory(next: Map<string, string>) {
    const changes: UiStateChanges = {};
    for (const [key, value] of next) {
      if (this.memory.get(key) !== value) {
        changes[key] = value;
      }
    }
    for (const key of this.memory.keys()) {
      if (!next.has(key)) {
        changes[key] = null;
      }
    }
    if (Object.keys(changes).length === 0) return;

    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        this.memory.delete(key);
      } else {
        this.memory.set(key, value);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(changes);
      } catch (error) {
        console.warn(
          "[ui-state] Change listener failed:",
          (error as Error).message,
        );
      }
    }
  }

  private startWatcher() {
    try {
      // Watch the directory, not the file: atomic renames replace the inode,
      // which silently kills direct file watches on some platforms. The
      // prefix match (not equality) is deliberate — Bun's fs.watch reports a
      // rename only under the *source* tmp name (`ui-state.json.<pid>….tmp`),
      // never the destination, so an exact-name filter drops every event.
      this.watcher = fs.watch(path.dirname(this.filePath), (_event, filename) => {
        if (filename && !filename.startsWith(UI_STATE_FILE_NAME)) return;
        this.scheduleWatchRead();
      });
    } catch (error) {
      console.warn(
        "[ui-state] File watcher unavailable; falling back to polling only:",
        (error as Error).message,
      );
    }
    // Stat-poll fallback: FSEvents/inotify can silently drop or coalesce
    // events; a 1s mtime poll guarantees eventual cross-host convergence.
    fs.watchFile(
      this.filePath,
      { interval: 1_000, persistent: false },
      (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
          this.scheduleWatchRead();
        }
      },
    );
  }

  private scheduleWatchRead() {
    if (this.watchTimer || this.disposed) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      // Expected state = on-disk content with our unflushed deltas on top.
      // Diffing that against memory means our own flushes (file == memory)
      // and pending-key overlaps never emit; only genuinely external
      // changes do.
      const next = this.pendingClear
        ? new Map<string, string>()
        : readUiStateFile(this.filePath);
      for (const [key, value] of this.pending) {
        if (value === null) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      this.reconcileMemory(next);
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }
}
