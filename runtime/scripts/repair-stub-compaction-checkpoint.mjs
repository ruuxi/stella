#!/usr/bin/env node
// Repair a stub compaction checkpoint without deleting raw thread history.
// Dry-run is the default. Apply requires Stella to be stopped, verifies that
// no Electron/Bun/other process still holds the DB or its WAL sidecars, takes
// BEGIN IMMEDIATE before authoritative reads, and writes a durable logical
// backup that can be reversed with --restore.
//
// RUNTIME REQUIREMENT: run this script — and its vitest suite
// (desktop/tests/runtime/scripts/repair-stub-compaction-checkpoint.test.ts) —
// under real Node >= 22 (e.g. /opt/homebrew/bin/node), NOT Bun. Bun 1.3.x
// does not ship the `node:sqlite` module this script depends on.
//
// Repair:
//   node runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --entry <stub-entry-id>
//   node runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --entry <stub-entry-id> \
//     --apply --confirm-stella-stopped
//
// Restore a repair from its JSON backup (dry-run first, then apply):
//   node runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --restore <backup.json>
//   node runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --restore <backup.json> \
//     --apply --confirm-stella-stopped

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const STUB_MAX_SUMMARY_CHARS = 200;
const STUB_MIN_TOKENS_BEFORE = 10_000;
const BACKUP_VERSION = 1;
const LSOF_PATH = "/usr/sbin/lsof";
const REQUIRED_ENTRY_COLUMNS = [
  "entry_id",
  "thread_key",
  "session_id",
  "parent_entry_id",
  "entry_type",
  "timestamp_iso",
  "created_at",
  "data_json",
  "insertion_sequence",
];

const fail = (message) => {
  throw new Error(message);
};

const quoteIdentifier = (value) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    fail(`Unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
};

const readFlag = (args, name) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for --${name}.`);
  }
  return value;
};

const hasFlag = (args, name) => args.includes(`--${name}`);

const expandHome = (value) => {
  if (!value?.startsWith("~")) return value;
  if (value !== "~" && !value.startsWith("~/")) {
    fail(`Unsupported home-relative path: ${value}`);
  }
  return path.join(os.homedir(), value.slice(value === "~" ? 1 : 2));
};

export const resolveExistingRegularFile = (input, label) => {
  if (!input) fail(`Missing ${label}.`);
  const expanded = expandHome(input);
  const absolute = path.resolve(expanded);
  if (!fs.existsSync(absolute)) fail(`${label} not found: ${absolute}`);
  const resolved = fs.realpathSync(absolute);
  if (!fs.statSync(resolved).isFile())
    fail(`${label} is not a regular file: ${resolved}`);
  return resolved;
};

const parseLsofRecords = (stdout) => {
  const holders = [];
  let current = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      if (current) holders.push(current);
      current = { pid: Number(value), command: "unknown", user: "unknown" };
    } else if (tag === "c" && current) current.command = value;
    else if (tag === "u" && current) current.user = value;
  }
  if (current) holders.push(current);
  return holders.filter((holder) => Number.isInteger(holder.pid));
};

export const listDatabaseHolders = (dbPath, ignoredPids = [process.pid]) => {
  if (process.platform !== "darwin") {
    fail("Active-writer verification is currently supported only on macOS.");
  }
  if (!fs.existsSync(LSOF_PATH))
    fail(`Required active-writer verifier not found: ${LSOF_PATH}`);
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(
    (candidate) => fs.existsSync(candidate),
  );
  const result = spawnSync(LSOF_PATH, ["-Fpcu", "--", ...candidates], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error)
    fail(`Could not inspect database holders: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    fail(`lsof failed (${result.status}): ${result.stderr.trim()}`);
  }
  const ignored = new Set(ignoredPids);
  return parseLsofRecords(result.stdout).filter(
    (holder) => !ignored.has(holder.pid),
  );
};

export const assertNoActiveDatabaseHolders = (
  dbPath,
  ignoredPids = [process.pid],
) => {
  const holders = listDatabaseHolders(dbPath, ignoredPids);
  if (holders.length === 0) return;
  fail(
    `Refusing apply while database holders are active: ${holders
      .map((holder) => `${holder.command} pid=${holder.pid}`)
      .join(", ")}. Quit Stella and its worker, then retry.`,
  );
};

const tableColumns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String(row.name));

const assertSchema = (db) => {
  const entryColumns = tableColumns(db, "runtime_thread_entries");
  const threadColumns = tableColumns(db, "runtime_threads");
  for (const column of REQUIRED_ENTRY_COLUMNS) {
    if (!entryColumns.includes(column))
      fail(`Database is missing runtime_thread_entries.${column}.`);
  }
  if (
    !threadColumns.includes("thread_key") ||
    !threadColumns.includes("summary")
  ) {
    fail("Database has an incompatible runtime_threads schema.");
  }
  return { entryColumns, threadColumns };
};

const selectColumns = (columns) => columns.map(quoteIdentifier).join(", ");

const parseCompactionData = (row) => {
  let data;
  try {
    data = JSON.parse(row.data_json ?? "{}");
  } catch (error) {
    fail(
      `Entry ${row.entry_id} has invalid data_json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return data && typeof data === "object" ? data : {};
};

const rowMatches = (left, right, columns) =>
  columns.every((column) => Object.is(left?.[column], right?.[column]));

const loadThreadEntries = (db, threadKey, entryColumns) =>
  db
    .prepare(
      `SELECT ${selectColumns(entryColumns)} FROM runtime_thread_entries
       WHERE thread_key = ?
       ORDER BY insertion_sequence ASC, rowid ASC`,
    )
    .all(threadKey);

const buildTopology = (rows) => {
  const byId = new Map(rows.map((row) => [row.entry_id, row]));
  const children = new Map();
  for (const row of rows) {
    if (row.parent_entry_id === null) continue;
    if (!byId.has(row.parent_entry_id)) {
      fail(
        `Thread already has dangling parent ${row.parent_entry_id} referenced by ${row.entry_id}.`,
      );
    }
    const bucket = children.get(row.parent_entry_id) ?? [];
    bucket.push(row);
    children.set(row.parent_entry_id, bucket);
  }
  return { byId, children };
};

const ancestorRows = (row, byId) => {
  const ancestors = [];
  const visited = new Set([row.entry_id]);
  let parentId = row.parent_entry_id;
  while (parentId !== null) {
    if (visited.has(parentId)) fail(`Cycle detected at ${parentId}.`);
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) fail(`Missing ancestor ${parentId}.`);
    ancestors.push(parent);
    parentId = parent.parent_entry_id;
  }
  return ancestors;
};

const descendantIds = (entryId, children) => {
  const descendants = new Set();
  const pending = [...(children.get(entryId) ?? [])];
  while (pending.length > 0) {
    const row = pending.pop();
    if (descendants.has(row.entry_id)) continue;
    descendants.add(row.entry_id);
    pending.push(...(children.get(row.entry_id) ?? []));
  }
  return descendants;
};

const nearestSurvivingParentId = (row, affectedIds, byId) => {
  let parentId = row.parent_entry_id;
  while (parentId !== null && affectedIds.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) fail(`Affected ancestor ${parentId} disappeared.`);
    parentId = parent.parent_entry_id;
  }
  return parentId;
};

const countPathRows = (byId, startEntryId, stopEntryId, includeStop) => {
  const counts = { message: 0, customMessage: 0 };
  const visited = new Set();
  let row = byId.get(startEntryId);
  while (row) {
    if (visited.has(row.entry_id)) {
      fail(`Cycle detected while counting path at ${row.entry_id}.`);
    }
    visited.add(row.entry_id);
    if (row.entry_id === stopEntryId && !includeStop) return counts;
    if (row.entry_type === "message") counts.message += 1;
    else if (row.entry_type === "custom_message") counts.customMessage += 1;
    if (row.entry_id === stopEntryId) return counts;
    row =
      row.parent_entry_id === null ? undefined : byId.get(row.parent_entry_id);
  }
  fail(`Path from ${startEntryId} does not reach boundary ${stopEntryId}.`);
};

export const analyzeRepair = (db, entryId) => {
  const { entryColumns, threadColumns } = assertSchema(db);
  const target = db
    .prepare(
      `SELECT ${selectColumns(entryColumns)} FROM runtime_thread_entries WHERE entry_id = ?`,
    )
    .get(entryId);
  if (!target) fail(`No entry with id ${entryId}.`);
  if (target.entry_type !== "compaction")
    fail(`Entry ${entryId} is ${target.entry_type}, not compaction.`);
  if (!Number.isSafeInteger(target.insertion_sequence))
    fail(`Entry ${entryId} lacks a safe insertion_sequence.`);

  const targetData = parseCompactionData(target);
  const summary = String(targetData.summary ?? "");
  const tokensBefore = Number(targetData.tokensBefore ?? 0);
  const fromEntryId = String(targetData.fromEntryId ?? "");
  if (summary.length >= STUB_MAX_SUMMARY_CHARS) {
    fail(
      `Refusing: summary is ${summary.length} chars (>= ${STUB_MAX_SUMMARY_CHARS}); not a stub.`,
    );
  }
  if (tokensBefore < STUB_MIN_TOKENS_BEFORE) {
    fail(
      `Refusing: tokensBefore is ${tokensBefore} (< ${STUB_MIN_TOKENS_BEFORE}).`,
    );
  }
  if (!fromEntryId || !String(targetData.toEntryId ?? "")) {
    fail(
      "Refusing: target compaction has no explicit fromEntryId/toEntryId range.",
    );
  }

  const rows = loadThreadEntries(db, target.thread_key, entryColumns);
  const { byId, children } = buildTopology(rows);
  const ancestors = ancestorRows(target, byId);
  const previous = ancestors.find((candidate) => {
    if (candidate.entry_type !== "compaction") return false;
    return (
      String(parseCompactionData(candidate).summary ?? "").length >=
      STUB_MAX_SUMMARY_CHARS
    );
  });
  if (!previous)
    fail(
      "No earlier healthy checkpoint exists on the target's authoritative parent path.",
    );
  const previousData = parseCompactionData(previous);
  const previousSummary = String(previousData.summary ?? "");
  const previousTo = byId.get(String(previousData.toEntryId ?? ""));
  if (!previousTo)
    fail(`Previous checkpoint ${previous.entry_id} has an invalid toEntryId.`);

  const descendants = descendantIds(target.entry_id, children);
  const affected = rows.filter(
    (row) =>
      row.entry_id === target.entry_id ||
      (descendants.has(row.entry_id) && row.entry_type === "compaction"),
  );
  if (
    affected.some(
      (candidate) => !Number.isSafeInteger(candidate.insertion_sequence),
    )
  ) {
    fail("An affected checkpoint lacks a safe insertion_sequence.");
  }
  // Validate every dependent checkpoint except the target itself. Filtering
  // by entry_id (not position) matters: `rows` is ordered by
  // insertion_sequence, so a dependent row that sorts BEFORE the target
  // would occupy index 0 and escape a slice(1)-style check.
  for (const candidate of affected.filter(
    (row) => row.entry_id !== target.entry_id,
  )) {
    const data = parseCompactionData(candidate);
    if (String(data.fromEntryId ?? "") !== fromEntryId) {
      fail(
        `Dependent compaction ${candidate.entry_id} starts from an incompatible range.`,
      );
    }
  }
  const affectedIds = new Set(affected.map((row) => row.entry_id));
  const reparents = rows
    .filter(
      (row) =>
        !affectedIds.has(row.entry_id) &&
        row.parent_entry_id !== null &&
        affectedIds.has(row.parent_entry_id),
    )
    .map((row) => ({
      before: row,
      afterParentEntryId: nearestSurvivingParentId(row, affectedIds, byId),
    }));

  const thread = db
    .prepare(
      `SELECT ${selectColumns(threadColumns)} FROM runtime_threads WHERE thread_key = ?`,
    )
    .get(target.thread_key);
  if (!thread) fail(`Missing runtime_threads row for ${target.thread_key}.`);
  const removedSummaries = new Set(
    affected.map((row) => String(parseCompactionData(row).summary ?? "")),
  );
  const metadataBelongsToAffectedOverlay =
    typeof thread.summary === "string" && removedSummaries.has(thread.summary);
  const threadSummaryAfter = metadataBelongsToAffectedOverlay
    ? previousSummary
    : thread.summary;

  const latestAffected = affected.reduce((latest, candidate) =>
    candidate.insertion_sequence > latest.insertion_sequence
      ? candidate
      : latest,
  );
  const latestAffectedTo = byId.get(
    String(parseCompactionData(latestAffected).toEntryId ?? ""),
  );
  if (!latestAffectedTo) {
    fail(
      `Affected checkpoint ${latestAffected.entry_id} has an invalid toEntryId.`,
    );
  }
  const targetFrom = byId.get(fromEntryId);
  const targetTo = byId.get(String(targetData.toEntryId));
  if (!targetFrom || !targetTo)
    fail("Target compaction range points outside its thread.");

  return {
    entryId,
    entryColumns,
    threadColumns,
    target,
    targetData,
    rows,
    affected,
    affectedIds,
    previous,
    previousSummary,
    reparents,
    thread,
    threadSummaryAfter,
    metadataBelongsToAffectedOverlay,
    counts: {
      storedInTargetRange: countPathRows(
        byId,
        targetTo.entry_id,
        targetFrom.entry_id,
        true,
      ),
      newlyExposedThroughDependentBoundary: countPathRows(
        byId,
        latestAffectedTo.entry_id,
        previousTo.entry_id,
        false,
      ),
    },
  };
};

const createBackupPath = (dbPath, entryId) =>
  path.join(
    path.dirname(dbPath),
    `stub-checkpoint-backup-${entryId}-${Date.now()}.json`,
  );

const writeDurableJson = (filePath, value) => {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directoryFd = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
};

const fullRowWhere = (columns) =>
  columns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");

const assertRepairPostconditions = (db, plan) => {
  const current = loadThreadEntries(
    db,
    plan.target.thread_key,
    plan.entryColumns,
  );
  const currentById = new Map(current.map((row) => [row.entry_id, row]));
  for (const deleted of plan.affected) {
    if (currentById.has(deleted.entry_id))
      fail(`Deleted checkpoint ${deleted.entry_id} is still present.`);
  }
  const reparentById = new Map(
    plan.reparents.map((item) => [item.before.entry_id, item]),
  );
  for (const before of plan.rows) {
    if (plan.affectedIds.has(before.entry_id)) continue;
    const after = currentById.get(before.entry_id);
    if (!after) fail(`Unrelated entry ${before.entry_id} disappeared.`);
    const reparent = reparentById.get(before.entry_id);
    for (const column of plan.entryColumns) {
      const expected =
        column === "parent_entry_id" && reparent
          ? reparent.afterParentEntryId
          : before[column];
      if (!Object.is(after[column], expected))
        fail(
          `Unrelated entry ${before.entry_id}.${column} changed unexpectedly.`,
        );
    }
  }
  buildTopology(current);
  const thread = db
    .prepare(
      `SELECT ${selectColumns(plan.threadColumns)} FROM runtime_threads WHERE thread_key = ?`,
    )
    .get(plan.target.thread_key);
  if (!Object.is(thread?.summary, plan.threadSummaryAfter))
    fail("Thread summary postcondition failed.");
};

export const applyRepairPlan = (
  db,
  dbPath,
  plan,
  backupPath = createBackupPath(dbPath, plan.entryId),
) => {
  const backup = {
    version: BACKUP_VERSION,
    kind: "stella-stub-checkpoint-repair",
    databasePath: dbPath,
    createdAt: new Date().toISOString(),
    entryColumns: plan.entryColumns,
    threadColumns: plan.threadColumns,
    targetEntryId: plan.entryId,
    deletedEntries: plan.affected,
    reparentedChildren: plan.reparents,
    threadBefore: plan.thread,
    threadSummaryAfter: plan.threadSummaryAfter,
    counts: plan.counts,
  };
  writeDurableJson(backupPath, backup);

  const updateParent = db.prepare(
    `UPDATE runtime_thread_entries SET parent_entry_id = ?
     WHERE entry_id = ? AND thread_key = ? AND parent_entry_id IS ?`,
  );
  for (const reparent of plan.reparents) {
    const result = updateParent.run(
      reparent.afterParentEntryId,
      reparent.before.entry_id,
      reparent.before.thread_key,
      reparent.before.parent_entry_id,
    );
    if (result.changes !== 1)
      fail(`CAS failed while reparenting ${reparent.before.entry_id}.`);
  }

  const deleteRow = db.prepare(
    `DELETE FROM runtime_thread_entries WHERE ${fullRowWhere(plan.entryColumns)}`,
  );
  // Delete descendants before ancestors so a future schema-level parent
  // foreign key cannot make a multi-checkpoint repair order-dependent.
  for (const row of [...plan.affected].reverse()) {
    const result = deleteRow.run(
      ...plan.entryColumns.map((column) => row[column]),
    );
    if (result.changes !== 1)
      fail(`CAS failed while deleting ${row.entry_id}.`);
  }

  if (!Object.is(plan.thread.summary, plan.threadSummaryAfter)) {
    const result = db
      .prepare(
        `UPDATE runtime_threads SET summary = ?
         WHERE thread_key = ? AND summary IS ?`,
      )
      .run(
        plan.threadSummaryAfter,
        plan.target.thread_key,
        plan.thread.summary,
      );
    if (result.changes !== 1)
      fail("CAS failed while updating runtime_threads.summary.");
  }
  assertRepairPostconditions(db, plan);
  return { backupPath, backup };
};

const loadBackup = (backupPath) => {
  const value = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  if (
    value?.version !== BACKUP_VERSION ||
    value?.kind !== "stella-stub-checkpoint-repair"
  ) {
    fail(`Unsupported repair backup: ${backupPath}`);
  }
  return value;
};

export const analyzeRestore = (db, dbPath, backup) => {
  const schema = assertSchema(db);
  if (path.resolve(backup.databasePath) !== dbPath) {
    fail(`Backup belongs to a different database path: ${backup.databasePath}`);
  }
  if (
    JSON.stringify(schema.entryColumns) !==
      JSON.stringify(backup.entryColumns) ||
    JSON.stringify(schema.threadColumns) !==
      JSON.stringify(backup.threadColumns)
  ) {
    fail("Database schema no longer matches the repair backup.");
  }
  for (const row of backup.deletedEntries) {
    const existing = db
      .prepare("SELECT 1 FROM runtime_thread_entries WHERE entry_id = ?")
      .get(row.entry_id);
    if (existing)
      fail(`Cannot restore: deleted entry ${row.entry_id} already exists.`);
    const sequenceOwner = db
      .prepare(
        "SELECT entry_id FROM runtime_thread_entries WHERE insertion_sequence = ?",
      )
      .get(row.insertion_sequence);
    if (sequenceOwner)
      fail(
        `Cannot restore: insertion_sequence ${row.insertion_sequence} is occupied.`,
      );
  }
  for (const reparent of backup.reparentedChildren) {
    const current = db
      .prepare(
        `SELECT ${selectColumns(backup.entryColumns)} FROM runtime_thread_entries WHERE entry_id = ?`,
      )
      .get(reparent.before.entry_id);
    if (!current)
      fail(
        `Cannot restore: reparented child ${reparent.before.entry_id} is missing.`,
      );
    for (const column of backup.entryColumns) {
      const expected =
        column === "parent_entry_id"
          ? reparent.afterParentEntryId
          : reparent.before[column];
      if (!Object.is(current[column], expected)) {
        fail(
          `Cannot restore: child ${reparent.before.entry_id}.${column} changed after repair.`,
        );
      }
    }
  }
  const thread = db
    .prepare(
      `SELECT ${selectColumns(backup.threadColumns)} FROM runtime_threads WHERE thread_key = ?`,
    )
    .get(backup.threadBefore.thread_key);
  if (!thread) fail("Cannot restore: runtime_threads row is missing.");
  if (!Object.is(thread.summary, backup.threadSummaryAfter)) {
    fail("Cannot restore: runtime_threads.summary changed after repair.");
  }
  return { schema, thread };
};

export const applyRestorePlan = (db, backup, restorePlan) => {
  const insert = db.prepare(
    `INSERT INTO runtime_thread_entries (${selectColumns(backup.entryColumns)})
     VALUES (${backup.entryColumns.map(() => "?").join(", ")})`,
  );
  for (const row of backup.deletedEntries) {
    const result = insert.run(
      ...backup.entryColumns.map((column) => row[column]),
    );
    if (result.changes !== 1)
      fail(`Restore insert failed for ${row.entry_id}.`);
  }
  const updateParent = db.prepare(
    `UPDATE runtime_thread_entries SET parent_entry_id = ?
     WHERE entry_id = ? AND thread_key = ? AND parent_entry_id IS ?`,
  );
  for (const reparent of backup.reparentedChildren) {
    const result = updateParent.run(
      reparent.before.parent_entry_id,
      reparent.before.entry_id,
      reparent.before.thread_key,
      reparent.afterParentEntryId,
    );
    if (result.changes !== 1)
      fail(`Restore CAS failed for child ${reparent.before.entry_id}.`);
  }
  if (!Object.is(backup.threadBefore.summary, backup.threadSummaryAfter)) {
    const result = db
      .prepare(
        `UPDATE runtime_threads SET summary = ?
         WHERE thread_key = ? AND summary IS ?`,
      )
      .run(
        backup.threadBefore.summary,
        backup.threadBefore.thread_key,
        backup.threadSummaryAfter,
      );
    if (result.changes !== 1)
      fail("Restore CAS failed for runtime_threads.summary.");
  }

  const restoredRows = loadThreadEntries(
    db,
    backup.threadBefore.thread_key,
    backup.entryColumns,
  );
  buildTopology(restoredRows);
  const restoredById = new Map(restoredRows.map((row) => [row.entry_id, row]));
  for (const row of backup.deletedEntries) {
    if (!rowMatches(restoredById.get(row.entry_id), row, backup.entryColumns)) {
      fail(`Restored entry ${row.entry_id} does not match its backup.`);
    }
  }
  for (const reparent of backup.reparentedChildren) {
    if (
      !rowMatches(
        restoredById.get(reparent.before.entry_id),
        reparent.before,
        backup.entryColumns,
      )
    ) {
      fail(
        `Restored child ${reparent.before.entry_id} does not match its backup.`,
      );
    }
  }
  const restoredThread = db
    .prepare(
      `SELECT ${selectColumns(backup.threadColumns)} FROM runtime_threads WHERE thread_key = ?`,
    )
    .get(backup.threadBefore.thread_key);
  if (!Object.is(restoredThread?.summary, backup.threadBefore.summary)) {
    fail("Restored runtime_threads.summary does not match its backup.");
  }
  return restorePlan;
};

const printRepairPlan = (plan) => {
  console.log(`Stub checkpoint     ${plan.entryId}`);
  console.log(`  thread            ${plan.target.thread_key}`);
  console.log(`  written           ${plan.target.timestamp_iso}`);
  console.log(`  tokensBefore      ${plan.targetData.tokensBefore}`);
  console.log(
    `  summary           ${JSON.stringify(String(plan.targetData.summary ?? ""))}`,
  );
  console.log(`Affected overlays  ${plan.affected.length}`);
  for (const row of plan.affected) {
    console.log(
      `  ${row.entry_id}  ${row.timestamp_iso}  ${String(parseCompactionData(row).summary ?? "").length} ch`,
    );
  }
  console.log(
    `Fallback checkpoint ${plan.previous.entry_id} (${plan.previousSummary.length} ch)`,
  );
  console.log(`Children reparented ${plan.reparents.length}`);
  const stored = plan.counts.storedInTargetRange;
  const exposed = plan.counts.newlyExposedThroughDependentBoundary;
  console.log(
    `Stored in target range        ${stored.message} message + ${stored.customMessage} custom_message rows`,
  );
  console.log(
    `Newly exposed through latest affected boundary  ${exposed.message} message + ${exposed.customMessage} custom_message rows`,
  );
  console.log(
    Object.is(plan.thread.summary, plan.threadSummaryAfter)
      ? "Thread metadata     preserved byte-for-byte"
      : `Thread metadata     restored to ${plan.previous.entry_id}`,
  );
};

const runLocked = (db, dbPath, work) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertNoActiveDatabaseHolders(dbPath, [process.pid]);
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const main = (argv = process.argv.slice(2)) => {
  const dbPath = resolveExistingRegularFile(readFlag(argv, "db"), "Database");
  const entryId = readFlag(argv, "entry");
  const restoreInput = readFlag(argv, "restore");
  const apply = hasFlag(argv, "apply");
  const confirmedStopped = hasFlag(argv, "confirm-stella-stopped");
  if (Boolean(entryId) === Boolean(restoreInput)) {
    fail("Pass exactly one of --entry <id> or --restore <backup.json>.");
  }
  if (apply && !confirmedStopped) {
    fail("Refusing --apply without --confirm-stella-stopped.");
  }
  if (apply) assertNoActiveDatabaseHolders(dbPath);

  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (entryId) {
      if (!apply) {
        const plan = analyzeRepair(db, entryId);
        printRepairPlan(plan);
        console.log(
          "\nDry run. Apply writes a durable logical backup, reparents direct children, deletes affected overlays, and updates metadata in one locked transaction.",
        );
        return;
      }
      const result = runLocked(db, dbPath, () => {
        const plan = analyzeRepair(db, entryId);
        printRepairPlan(plan);
        return applyRepairPlan(db, dbPath, plan);
      });
      console.log(
        `\nRepair committed. Reversible backup: ${result.backupPath}`,
      );
      return;
    }

    const backupPath = resolveExistingRegularFile(restoreInput, "Backup");
    const backup = loadBackup(backupPath);
    if (!apply) {
      analyzeRestore(db, dbPath, backup);
      console.log(`Restore backup      ${backupPath}`);
      console.log(`Entries restored    ${backup.deletedEntries.length}`);
      console.log(`Children restored   ${backup.reparentedChildren.length}`);
      console.log(
        "\nDry run. Re-run with --apply --confirm-stella-stopped to restore the backed-up overlays, parents, and thread summary.",
      );
      return;
    }
    runLocked(db, dbPath, () => {
      const plan = analyzeRestore(db, dbPath, backup);
      return applyRestorePlan(db, backup, plan);
    });
    console.log(`Restore committed from ${backupPath}.`);
  } finally {
    db.close();
  }
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
