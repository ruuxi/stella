/**
 * MemoryStore - bounded curated memory backed by SQLite (memory_entries table).
 *
 * Two parallel targets:
 *   - "memory": agent's own notes (cross-session patterns, recurring decisions)
 *   - "user":   user identity, preferences, expectations
 *
 * Both targets are injected into the Orchestrator system prompt as a frozen
 * snapshot at session start. Mid-session writes update the database immediately
 * (durable) but do NOT change the snapshot - the snapshot is captured once at
 * loadSnapshot() and stays stable for the whole session. This preserves the
 * model provider's prefix cache.
 *
 * Substring matching (Hermes-style) is used for replace/remove so the model can
 * target an entry by a short unique fragment rather than by ID.
 *
 * Char-budget enforcement keeps the system-prompt block bounded. Over-budget
 * adds return a structured error including the current entries so the model
 * can consolidate before retrying.
 *
 * Directly ported in spirit from the Hermes Agent memory_tool.MemoryStore
 * (https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py).
 */

import type { SqliteDatabase } from "../storage/shared.js";
import { generateLocalId } from "../storage/shared.js";

export type MemoryTarget = "memory" | "user";

export type MemoryToolResult = {
  success: boolean;
  target: MemoryTarget;
  entries?: string[];
  usage?: string;
  message?: string;
  error?: string;
  matches?: string[];
};

export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;

const ENTRY_DELIMITER = "\n§\n";
const SEPARATOR = "═".repeat(46);

type MemoryRow = {
  id: string;
  content: string;
  createdAt: number;
};

const isMemoryTarget = (value: unknown): value is MemoryTarget =>
  value === "memory" || value === "user";

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const previewEntry = (entry: string, maxChars = 80): string =>
  entry.length <= maxChars ? entry : `${entry.slice(0, maxChars)}...`;

export class MemoryStore {
  private readonly memoryCharLimit: number;
  private readonly userCharLimit: number;
  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private snapshot: { memory: string; user: string } = { memory: "", user: "" };
  private snapshotLoaded = false;

  constructor(
    private readonly db: SqliteDatabase,
    opts?: { memoryCharLimit?: number; userCharLimit?: number },
  ) {
    this.memoryCharLimit = opts?.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
    this.userCharLimit = opts?.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
  }

  /**
   * Read both targets from disk and capture the frozen snapshot.
   * Call once per session at startup.
   */
  loadSnapshot(): void {
    this.memoryEntries = this.readEntries("memory");
    this.userEntries = this.readEntries("user");
    this.snapshot = {
      memory: this.renderBlock("memory", this.memoryEntries),
      user: this.renderBlock("user", this.userEntries),
    };
    this.snapshotLoaded = true;
  }

  /**
   * Returns the frozen snapshot for system-prompt injection. Returns null when
   * the target has no entries. Always reflects the state at loadSnapshot()
   * time, never the live state - see class docstring.
   */
  formatForSystemPrompt(target: MemoryTarget): string | null {
    if (!this.snapshotLoaded) {
      return null;
    }
    const block = this.snapshot[target];
    return block.length > 0 ? block : null;
  }

  add(target: MemoryTarget, content: string): MemoryToolResult {
    if (!isMemoryTarget(target)) {
      return { success: false, target, error: `Invalid target '${target}'.` };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { success: false, target, error: "Content cannot be empty." };
    }

    let result: MemoryToolResult | null = null;
    this.withTransaction(() => {
      const entries = this.readEntries(target);

      if (entries.includes(trimmed)) {
        this.setEntries(target, entries);
        result = this.successResponse(
          target,
          "Entry already exists (no duplicate added).",
        );
        return;
      }

      const limit = this.charLimit(target);
      const projected = entries.concat([trimmed]);
      const projectedTotal = projected.join(ENTRY_DELIMITER).length;
      if (projectedTotal > limit) {
        const current = entries.join(ENTRY_DELIMITER).length;
        result = {
          success: false,
          target,
          error:
            `Memory at ${formatNumber(current)}/${formatNumber(limit)} chars. ` +
            `Adding this entry (${trimmed.length} chars) would exceed the limit. ` +
            `Replace or remove existing entries first.`,
          entries,
          usage: `${formatNumber(current)}/${formatNumber(limit)}`,
        };
        return;
      }

      const now = Date.now();
      this.db
        .prepare(
          `
          INSERT INTO memory_entries (id, target, content, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(generateLocalId(), target, trimmed, now, now);
      this.setEntries(target, projected);
      result = this.successResponse(target, "Entry added.");
    });
    return result ?? { success: false, target, error: "Unknown error." };
  }

  replace(
    target: MemoryTarget,
    oldText: string,
    newContent: string,
  ): MemoryToolResult {
    if (!isMemoryTarget(target)) {
      return { success: false, target, error: `Invalid target '${target}'.` };
    }
    const oldTrimmed = oldText.trim();
    if (!oldTrimmed) {
      return { success: false, target, error: "oldText cannot be empty." };
    }
    const newTrimmed = newContent.trim();
    if (!newTrimmed) {
      return {
        success: false,
        target,
        error: "content cannot be empty. Use 'remove' to delete entries.",
      };
    }

    let result: MemoryToolResult | null = null;
    this.withTransaction(() => {
      const rows = this.readRows(target);
      const matches = rows.filter((row) => row.content.includes(oldTrimmed));

      if (matches.length === 0) {
        result = {
          success: false,
          target,
          error: `No entry matched '${oldTrimmed}'.`,
        };
        return;
      }

      if (matches.length > 1) {
        const unique = new Set(matches.map((m) => m.content));
        if (unique.size > 1) {
          result = {
            success: false,
            target,
            error: `Multiple entries matched '${oldTrimmed}'. Be more specific.`,
            matches: matches.map((m) => previewEntry(m.content)),
          };
          return;
        }
      }

      const target_row = matches[0]!;
      const projected = rows.map((r) =>
        r.id === target_row.id ? { ...r, content: newTrimmed } : r,
      );
      const projectedTotal = projected
        .map((r) => r.content)
        .join(ENTRY_DELIMITER).length;
      const limit = this.charLimit(target);
      if (projectedTotal > limit) {
        result = {
          success: false,
          target,
          error:
            `Replacement would put memory at ${formatNumber(projectedTotal)}/${formatNumber(limit)} chars. ` +
            `Shorten the new content or remove other entries first.`,
        };
        return;
      }

      const now = Date.now();
      this.db
        .prepare(
          `UPDATE memory_entries SET content = ?, updated_at = ? WHERE id = ?`,
        )
        .run(newTrimmed, now, target_row.id);
      this.setEntries(target, projected.map((r) => r.content));
      result = this.successResponse(target, "Entry replaced.");
    });
    return result ?? { success: false, target, error: "Unknown error." };
  }

  remove(target: MemoryTarget, oldText: string): MemoryToolResult {
    if (!isMemoryTarget(target)) {
      return { success: false, target, error: `Invalid target '${target}'.` };
    }
    const oldTrimmed = oldText.trim();
    if (!oldTrimmed) {
      return { success: false, target, error: "oldText cannot be empty." };
    }

    let result: MemoryToolResult | null = null;
    this.withTransaction(() => {
      const rows = this.readRows(target);
      const matches = rows.filter((row) => row.content.includes(oldTrimmed));

      if (matches.length === 0) {
        result = {
          success: false,
          target,
          error: `No entry matched '${oldTrimmed}'.`,
        };
        return;
      }

      if (matches.length > 1) {
        const unique = new Set(matches.map((m) => m.content));
        if (unique.size > 1) {
          result = {
            success: false,
            target,
            error: `Multiple entries matched '${oldTrimmed}'. Be more specific.`,
            matches: matches.map((m) => previewEntry(m.content)),
          };
          return;
        }
      }

      const target_row = matches[0]!;
      this.db
        .prepare(`DELETE FROM memory_entries WHERE id = ?`)
        .run(target_row.id);
      const remaining = rows.filter((r) => r.id !== target_row.id);
      this.setEntries(target, remaining.map((r) => r.content));
      result = this.successResponse(target, "Entry removed.");
    });
    return result ?? { success: false, target, error: "Unknown error." };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private withTransaction(work: () => void): void {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private readRows(target: MemoryTarget): MemoryRow[] {
    // Order by rowid (SQLite's implicit monotonic insertion sequence) so
    // entries inserted within the same millisecond preserve insertion order.
    // created_at is not unique enough on fast successive writes.
    const rows = this.db
      .prepare(
        `
        SELECT id, content, created_at AS createdAt
        FROM memory_entries
        WHERE target = ?
        ORDER BY rowid ASC
      `,
      )
      .all(target) as Array<{
      id: string;
      content: string;
      createdAt: number;
    }>;
    return rows;
  }

  private readEntries(target: MemoryTarget): string[] {
    return this.readRows(target).map((row) => row.content);
  }

  private setEntries(target: MemoryTarget, entries: string[]): void {
    if (target === "user") {
      this.userEntries = entries;
    } else {
      this.memoryEntries = entries;
    }
  }

  private entriesFor(target: MemoryTarget): string[] {
    return target === "user" ? this.userEntries : this.memoryEntries;
  }

  private charLimit(target: MemoryTarget): number {
    return target === "user" ? this.userCharLimit : this.memoryCharLimit;
  }

  private successResponse(
    target: MemoryTarget,
    message?: string,
  ): MemoryToolResult {
    const entries = this.entriesFor(target);
    const current = entries.join(ENTRY_DELIMITER).length;
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    return {
      success: true,
      target,
      entries,
      usage: `${pct}% — ${formatNumber(current)}/${formatNumber(limit)} chars`,
      ...(message ? { message } : {}),
    };
  }

  private renderBlock(target: MemoryTarget, entries: string[]): string {
    if (entries.length === 0) {
      return "";
    }
    const limit = this.charLimit(target);
    const content = entries.join(ENTRY_DELIMITER);
    const current = content.length;
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    const header =
      target === "user"
        ? `USER PROFILE (who the user is) [${pct}% — ${formatNumber(current)}/${formatNumber(limit)} chars]`
        : `MEMORY (your personal notes) [${pct}% — ${formatNumber(current)}/${formatNumber(limit)} chars]`;
    return `${SEPARATOR}\n${header}\n${SEPARATOR}\n${content}`;
  }
}
