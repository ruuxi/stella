#!/usr/bin/env node
// Repair a stub compaction checkpoint: a compaction entry whose summary is a
// near-empty fragment standing in for a large span (observed live 2026-07-18:
// a 55-char "## Topic" fragment replacing a ~190k-token orchestrator span).
//
// Compaction is a non-destructive overlay: the raw entries of the folded span
// still exist in `runtime_thread_entries`. Delete the stub and every later
// compaction that extended the same overlay range: those descendants were
// summarized from the already-damaged projection and cannot recover the raw
// span. The projection then falls back to the previous healthy checkpoint plus
// raw messages, and the fixed summarizer can regenerate a proper checkpoint.
//
// Usage (Node >=22.5 only; QUIT Stella first — never apply against a live
// writer, and do not invoke this script with Bun):
//   node runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite \
//     --entry 01KXSGPM354E01QJ3SXF6V89PJ            # stub entry id
//   ...inspect the dry-run report, then re-run with both
//   --apply --confirm-stella-stopped.
//
// The deleted rows (and the pre-repair runtime_threads summary) are backed up
// to a JSON file next to the DB so the repair is reversible. Search metadata is
// changed only with compare-and-swap: if it equals one of the removed overlay
// summaries, it falls back to the previous healthy checkpoint; unrelated newer
// metadata is preserved byte-for-byte.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const readFlag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const expandHome = (p) =>
  p?.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

const dbPath = expandHome(readFlag("db"));
const entryId = readFlag("entry");
const apply = hasFlag("apply");
const confirmedStopped = hasFlag("confirm-stella-stopped");

// A stub is a tiny summary standing in for a big span. Mirrors the
// THREAD_SUMMARY_MIN_ACCEPT_CHARS / floor-exempt logic in thread-runtime.ts.
const STUB_MAX_SUMMARY_CHARS = 200;
const STUB_MIN_TOKENS_BEFORE = 10_000;

if (!entryId) {
  console.error("Missing --entry <compaction entry id>.");
  process.exit(1);
}
if (!dbPath) {
  console.error("Missing --db <explicit sqlite path>.");
  process.exit(1);
}
if (apply && !confirmedStopped) {
  console.error(
    "Refusing --apply without --confirm-stella-stopped. Quit Stella, verify the worker has exited, then pass both flags.",
  );
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: !apply });
try {
  const row = db
    .prepare(
      `SELECT entry_id, thread_key, session_id, parent_entry_id, entry_type,
              timestamp_iso, created_at, data_json, append_seq,
              insertion_sequence
       FROM runtime_thread_entries WHERE entry_id = ?`,
    )
    .get(entryId);
  if (!row) {
    console.error(`No entry with id ${entryId}.`);
    process.exit(1);
  }
  if (row.entry_type !== "compaction") {
    console.error(`Entry ${entryId} is ${row.entry_type}, not compaction.`);
    process.exit(1);
  }

  const data = JSON.parse(row.data_json ?? "{}");
  const summary = String(data.summary ?? "");
  const tokensBefore = Number(data.tokensBefore ?? 0);
  const fromEntryId = String(data.fromEntryId ?? "");
  if (summary.length >= STUB_MAX_SUMMARY_CHARS) {
    console.error(
      `Refusing: summary is ${summary.length} chars (>= ${STUB_MAX_SUMMARY_CHARS}) — not a stub.`,
    );
    process.exit(1);
  }
  if (tokensBefore < STUB_MIN_TOKENS_BEFORE) {
    console.error(
      `Refusing: tokensBefore is ${tokensBefore} (< ${STUB_MIN_TOKENS_BEFORE}) — span too small to qualify as a destroyed checkpoint.`,
    );
    process.exit(1);
  }
  if (!fromEntryId) {
    console.error(
      "Refusing: target compaction has no fromEntryId; this repair only handles explicit overlay ranges.",
    );
    process.exit(1);
  }

  // Later compactions normalize their start to the active overlay's original
  // fromEntryId. They therefore depend on the damaged projection and must be
  // removed with the stub. Refuse any unfamiliar later overlay shape. Use the
  // storage projection's authoritative total order; timestamps can collide or
  // arrive out of order.
  const affected = db
    .prepare(
      `SELECT entry_id, thread_key, session_id, parent_entry_id, entry_type,
              timestamp_iso, created_at, data_json, append_seq,
              insertion_sequence
       FROM runtime_thread_entries
       WHERE thread_key = ? AND entry_type = 'compaction'
         AND insertion_sequence >= ?
       ORDER BY insertion_sequence ASC`,
    )
    .all(row.thread_key, row.insertion_sequence)
    .map((candidate) => ({
      row: candidate,
      data: JSON.parse(candidate.data_json ?? "{}"),
    }));
  if (affected[0]?.row.entry_id !== entryId) {
    console.error(
      `Refusing: could not anchor affected overlay chain at ${entryId}.`,
    );
    process.exit(1);
  }
  const incompatibleDescendant = affected
    .slice(1)
    .find(
      (candidate) => String(candidate.data.fromEntryId ?? "") !== fromEntryId,
    );
  if (incompatibleDescendant) {
    console.error(
      `Refusing: later compaction ${incompatibleDescendant.row.entry_id} starts from a different range.`,
    );
    process.exit(1);
  }

  // The healthy summary to restore onto runtime_threads: the latest earlier
  // compaction checkpoint on the same thread with a non-stub summary. Use the
  // same total order as transcript projection, not wall-clock time.
  const previous = db
    .prepare(
      `SELECT entry_id, data_json FROM runtime_thread_entries
       WHERE thread_key = ? AND entry_type = 'compaction'
         AND insertion_sequence < ?
       ORDER BY insertion_sequence DESC`,
    )
    .all(row.thread_key, row.insertion_sequence)
    .map((candidate) => ({
      entryId: candidate.entry_id,
      summary: String(JSON.parse(candidate.data_json ?? "{}").summary ?? ""),
    }))
    .find((candidate) => candidate.summary.length >= STUB_MAX_SUMMARY_CHARS);

  const thread = db
    .prepare(`SELECT summary FROM runtime_threads WHERE thread_key = ?`)
    .get(row.thread_key);
  const threadSummary =
    typeof thread?.summary === "string" ? thread.summary : null;
  const removedSummaries = new Set(
    affected.map((candidate) => String(candidate.data.summary ?? "")),
  );
  const metadataBelongsToAffectedOverlay =
    threadSummary !== null && removedSummaries.has(threadSummary);
  const summaryRepair = metadataBelongsToAffectedOverlay
    ? previous
      ? `replace affected overlay metadata with ${previous.entryId}`
      : "clear affected overlay metadata (no earlier healthy checkpoint)"
    : "preserve current metadata summary (it is unrelated to the affected overlays)";

  console.log(`Stub checkpoint     ${entryId}`);
  console.log(`  thread            ${row.thread_key}`);
  console.log(`  written           ${row.timestamp_iso}`);
  console.log(`  tokensBefore      ${tokensBefore}`);
  console.log(`  summary (${summary.length} ch)  ${JSON.stringify(summary)}`);
  console.log(`Affected overlays  ${affected.length}`);
  for (const candidate of affected) {
    console.log(
      `  ${candidate.row.entry_id}  ${candidate.row.timestamp_iso}  ${String(candidate.data.summary ?? "").length} ch`,
    );
  }
  console.log(
    previous
      ? `Fallback checkpoint ${previous.entryId} (${previous.summary.length} ch) — projection reverts to it after deleting the affected overlays.`
      : "No earlier healthy checkpoint — projection reverts to raw messages only.",
  );
  console.log(
    `Thread metadata     ${threadSummary?.length ?? 0} ch — ${summaryRepair}.`,
  );

  if (!apply) {
    console.log(
      "\nDry run. After quitting Stella and verifying its worker exited, re-run with --apply --confirm-stella-stopped to:",
    );
    console.log(
      `  1. back up all affected rows + current thread summary to JSON`,
    );
    console.log(
      `  2. DELETE ${affected.length} affected compaction overlay(s)`,
    );
    console.log(`  3. ${summaryRepair}`);
    process.exit(0);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Revalidate the full affected chain after taking the write lock.
    const affectedUnderLock = db
      .prepare(
        `SELECT entry_id, data_json FROM runtime_thread_entries
         WHERE thread_key = ? AND entry_type = 'compaction'
           AND insertion_sequence >= ?
         ORDER BY insertion_sequence ASC`,
      )
      .all(row.thread_key, row.insertion_sequence);
    const chainUnchanged =
      affectedUnderLock.length === affected.length &&
      affectedUnderLock.every(
        (candidate, index) =>
          candidate.entry_id === affected[index].row.entry_id &&
          candidate.data_json === affected[index].row.data_json,
      );
    if (!chainUnchanged) {
      throw new Error(
        "Affected compaction chain changed before apply; nothing was deleted.",
      );
    }

    const backupPath = path.join(
      path.dirname(dbPath),
      `stub-checkpoint-backup-${entryId}-${Date.now()}.json`,
    );
    fs.writeFileSync(
      backupPath,
      JSON.stringify(
        {
          deletedEntries: affected.map((candidate) => candidate.row),
          threadSummaryBefore: threadSummary,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );

    const deleteRow = db.prepare(
      `DELETE FROM runtime_thread_entries
       WHERE entry_id = ? AND thread_key = ? AND data_json = ?`,
    );
    for (const candidate of affected) {
      const deletion = deleteRow.run(
        candidate.row.entry_id,
        row.thread_key,
        candidate.row.data_json,
      );
      if (deletion.changes !== 1) {
        throw new Error(
          `Overlay ${candidate.row.entry_id} changed before apply; transaction rolled back.`,
        );
      }
    }

    if (metadataBelongsToAffectedOverlay) {
      db.prepare(
        `UPDATE runtime_threads SET summary = ?
         WHERE thread_key = ? AND summary = ?`,
      ).run(previous?.summary ?? null, row.thread_key, threadSummary);
    }
    db.exec("COMMIT");

    console.log(
      `\nDeleted ${affected.length} affected compaction overlay(s), beginning with ${entryId}.`,
    );
    if (metadataBelongsToAffectedOverlay) {
      console.log(
        previous
          ? `Replaced affected thread metadata from ${previous.entryId}.`
          : "Cleared affected thread metadata.",
      );
    } else {
      console.log("Preserved the newer runtime_threads.summary metadata.");
    }
    console.log(`Backup written to ${backupPath}.`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(
    "Relaunch Stella; the next turn past the compaction trigger regenerates a full checkpoint.",
  );
} finally {
  db.close();
}
