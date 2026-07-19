import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeRepair,
  analyzeRestore,
  applyRepairPlan,
  applyRestorePlan,
  assertNoActiveDatabaseHolders,
  listDatabaseHolders,
} from "../../../../runtime/scripts/repair-stub-compaction-checkpoint.mjs";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../../../runtime/scripts/repair-stub-compaction-checkpoint.mjs",
);
const healthySummary = `Topic\n${"healthy context ".repeat(18)}\nKey Points\n- decisions\nCurrent State\n- stable\nOpen Items\n- none`;
const stubSummary = "Compacted conversation checkpoint.";
const dependentSummaryA = `Topic\n${"dependent branch alpha ".repeat(12)}\nKey Points\n- alpha\nCurrent State\n- active\nOpen Items\n- none`;
const dependentSummaryB = `Topic\n${"dependent branch beta ".repeat(12)}\nKey Points\n- beta\nCurrent State\n- active\nOpen Items\n- none`;

type Entry = {
  entryId: string;
  parentEntryId: string | null;
  entryType: "message" | "custom_message" | "compaction";
  data?: unknown;
};

const temporaryDirectories: string[] = [];

const makeDatabase = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "stella-stub-repair-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "stella.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE runtime_threads (
      thread_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_thread_entries (
      entry_id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_entry_id TEXT,
      entry_type TEXT NOT NULL,
      timestamp_iso TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data_json TEXT,
      insertion_sequence INTEGER UNIQUE
    );
    INSERT INTO runtime_threads
      (thread_key, conversation_id, name, summary, last_used_at)
    VALUES ('thread-1', 'conversation-1', 'Repair fixture', ?, 1234);
  `);
  db.prepare(
    "UPDATE runtime_threads SET summary = ? WHERE thread_key = 'thread-1'",
  ).run(dependentSummaryA);

  let sequence = 0;
  const insert = db.prepare(`
    INSERT INTO runtime_thread_entries (
      entry_id, thread_key, session_id, parent_entry_id, entry_type,
      timestamp_iso, created_at, data_json, insertion_sequence
    ) VALUES (?, 'thread-1', 'session-1', ?, ?, ?, ?, ?, ?)
  `);
  const add = ({ entryId, parentEntryId, entryType, data }: Entry) => {
    sequence += 1;
    insert.run(
      entryId,
      parentEntryId,
      entryType,
      `2026-07-18T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      sequence,
      data === undefined ? null : JSON.stringify(data),
      sequence,
    );
  };

  add({ entryId: "m0", parentEntryId: null, entryType: "message" });
  add({ entryId: "m1", parentEntryId: "m0", entryType: "message" });
  add({
    entryId: "healthy",
    parentEntryId: "m1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "m1",
      summary: healthySummary,
      tokensBefore: 8_000,
    },
  });
  add({ entryId: "m2", parentEntryId: "healthy", entryType: "message" });
  add({ entryId: "m3", parentEntryId: "m2", entryType: "custom_message" });
  add({
    entryId: "stub",
    parentEntryId: "m3",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "m3",
      summary: stubSummary,
      tokensBefore: 190_576,
    },
  });
  add({ entryId: "alpha-1", parentEntryId: "stub", entryType: "message" });
  add({ entryId: "unrelated", parentEntryId: "m2", entryType: "message" });
  add({
    entryId: "dependent-a",
    parentEntryId: "alpha-1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "alpha-1",
      summary: dependentSummaryA,
      tokensBefore: 191_000,
    },
  });
  add({
    entryId: "dependent-a-2",
    parentEntryId: "dependent-a",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "alpha-1",
      summary: `${dependentSummaryA}\nNested continuation.`,
      tokensBefore: 191_500,
    },
  });
  add({
    entryId: "alpha-2",
    parentEntryId: "dependent-a-2",
    entryType: "message",
  });
  add({
    entryId: "beta-1",
    parentEntryId: "stub",
    entryType: "custom_message",
  });
  add({
    entryId: "dependent-b",
    parentEntryId: "beta-1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "beta-1",
      summary: dependentSummaryB,
      tokensBefore: 192_000,
    },
  });
  add({
    entryId: "beta-2",
    parentEntryId: "dependent-b",
    entryType: "message",
  });
  // A legacy unrelated row may lack the newer global sequence. Its parent
  // topology is still authoritative and must not make a targeted repair fail.
  db.prepare(
    "UPDATE runtime_thread_entries SET insertion_sequence = NULL WHERE entry_id = 'unrelated'",
  ).run();

  return { db, dbPath, directory };
};

const parentOf = (db: DatabaseSync, entryId: string) =>
  db
    .prepare(
      "SELECT parent_entry_id FROM runtime_thread_entries WHERE entry_id = ?",
    )
    .get(entryId)?.parent_entry_id;

const rowCount = (db: DatabaseSync, entryId: string) =>
  Number(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM runtime_thread_entries WHERE entry_id = ?",
      )
      .get(entryId)?.count,
  );

const danglingParentCount = (db: DatabaseSync) =>
  Number(
    db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM runtime_thread_entries AS child
        LEFT JOIN runtime_thread_entries AS parent
          ON parent.entry_id = child.parent_entry_id
        WHERE child.parent_entry_id IS NOT NULL
          AND parent.entry_id IS NULL
      `,
      )
      .get()?.count,
  );

const chainToRoot = (db: DatabaseSync, entryId: string) => {
  const chain: string[] = [];
  let current: string | null = entryId;
  while (current !== null) {
    chain.push(current);
    current = (parentOf(db, current) as string | null) ?? null;
  }
  return chain;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stub compaction checkpoint repair", () => {
  it("reparents every branch around multiple deleted overlays and restores exactly", () => {
    const { db, dbPath, directory } = makeDatabase();
    const unrelatedBefore = db
      .prepare(
        "SELECT * FROM runtime_thread_entries WHERE entry_id = 'unrelated'",
      )
      .get();
    const backupPath = path.join(directory, "repair.json");

    db.exec("BEGIN IMMEDIATE");
    const plan = analyzeRepair(db, "stub");
    expect(
      plan.affected.map((row: { entry_id: string }) => row.entry_id),
    ).toEqual(["stub", "dependent-a", "dependent-a-2", "dependent-b"]);
    expect(plan.counts.newlyExposedThroughDependentBoundary).toEqual({
      message: 1,
      customMessage: 2,
    });
    const { backup } = applyRepairPlan(db, dbPath, plan, backupPath);
    db.exec("COMMIT");

    expect(danglingParentCount(db)).toBe(0);
    expect(chainToRoot(db, "alpha-2")).toEqual([
      "alpha-2",
      "alpha-1",
      "m3",
      "m2",
      "healthy",
      "m1",
      "m0",
    ]);
    expect(chainToRoot(db, "beta-2")).toEqual([
      "beta-2",
      "beta-1",
      "m3",
      "m2",
      "healthy",
      "m1",
      "m0",
    ]);
    expect(
      db
        .prepare(
          "SELECT * FROM runtime_thread_entries WHERE entry_id = 'unrelated'",
        )
        .get(),
    ).toEqual(unrelatedBefore);
    expect(
      db
        .prepare(
          "SELECT summary FROM runtime_threads WHERE thread_key = 'thread-1'",
        )
        .get()?.summary,
    ).toBe(healthySummary);

    db.exec("BEGIN IMMEDIATE");
    const restorePlan = analyzeRestore(db, dbPath, backup);
    applyRestorePlan(db, backup, restorePlan);
    db.exec("COMMIT");

    expect(danglingParentCount(db)).toBe(0);
    expect(chainToRoot(db, "alpha-2")).toContain("dependent-a");
    expect(chainToRoot(db, "beta-2")).toContain("dependent-b");
    expect(parentOf(db, "alpha-1")).toBe("stub");
    expect(parentOf(db, "beta-1")).toBe("stub");
    expect(
      db
        .prepare(
          "SELECT summary FROM runtime_threads WHERE thread_key = 'thread-1'",
        )
        .get()?.summary,
    ).toBe(dependentSummaryA);
    db.close();
  });

  it("fails a stale child CAS and can roll the whole repair back", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.exec("BEGIN IMMEDIATE");
    const plan = analyzeRepair(db, "stub");
    db.prepare(
      "UPDATE runtime_thread_entries SET parent_entry_id = 'm2' WHERE entry_id = 'alpha-1'",
    ).run();
    expect(() =>
      applyRepairPlan(
        db,
        dbPath,
        plan,
        path.join(directory, "race-backup.json"),
      ),
    ).toThrow("CAS failed while reparenting alpha-1");
    db.exec("ROLLBACK");

    expect(parentOf(db, "alpha-1")).toBe("stub");
    expect(rowCount(db, "stub")).toBe(1);
    expect(rowCount(db, "dependent-a")).toBe(1);
    expect(rowCount(db, "dependent-b")).toBe(1);
    db.close();
  });

  it("fails stale thread metadata CAS and rolls back prior row changes", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.exec("BEGIN IMMEDIATE");
    const plan = analyzeRepair(db, "stub");
    db.prepare(
      "UPDATE runtime_threads SET summary = 'raced metadata' WHERE thread_key = 'thread-1'",
    ).run();
    expect(() =>
      applyRepairPlan(
        db,
        dbPath,
        plan,
        path.join(directory, "metadata-race.json"),
      ),
    ).toThrow("CAS failed while updating runtime_threads.summary");
    db.exec("ROLLBACK");

    expect(rowCount(db, "stub")).toBe(1);
    expect(parentOf(db, "alpha-1")).toBe("stub");
    expect(
      db
        .prepare(
          "SELECT summary FROM runtime_threads WHERE thread_key = 'thread-1'",
        )
        .get()?.summary,
    ).toBe(dependentSummaryA);
    db.close();
  });

  it("detects a stale previous healthy checkpoint before commit", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.exec("BEGIN IMMEDIATE");
    const plan = analyzeRepair(db, "stub");
    db.prepare(
      "UPDATE runtime_thread_entries SET data_json = '{}' WHERE entry_id = 'healthy'",
    ).run();
    expect(() =>
      applyRepairPlan(
        db,
        dbPath,
        plan,
        path.join(directory, "healthy-race.json"),
      ),
    ).toThrow("Unrelated entry healthy.data_json changed unexpectedly");
    db.exec("ROLLBACK");

    expect(rowCount(db, "stub")).toBe(1);
    expect(parentOf(db, "alpha-1")).toBe("stub");
    db.close();
  });

  it("refuses restore after thread metadata becomes stale", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.exec("BEGIN IMMEDIATE");
    const plan = analyzeRepair(db, "stub");
    const { backup } = applyRepairPlan(
      db,
      dbPath,
      plan,
      path.join(directory, "stale-backup.json"),
    );
    db.exec("COMMIT");
    db.prepare(
      "UPDATE runtime_threads SET summary = 'newer metadata' WHERE thread_key = 'thread-1'",
    ).run();

    expect(() => analyzeRestore(db, dbPath, backup)).toThrow(
      "runtime_threads.summary changed after repair",
    );
    expect(rowCount(db, "stub")).toBe(0);
    db.close();
  });

  it("detects and refuses a separate process holding the database", async () => {
    const { db, dbPath } = makeDatabase();
    db.close();
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
        dbPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", () => resolve());
    });
    try {
      expect(
        listDatabaseHolders(dbPath).some(
          (item: { pid: number }) => item.pid === holder.pid,
        ),
      ).toBe(true);
      expect(() => assertNoActiveDatabaseHolders(dbPath)).toThrow(
        "Refusing apply while database holders are active",
      );
    } finally {
      holder.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        holder.once("exit", () => resolve()),
      );
    }
  });

  it("runs CLI dry-run, apply, restore dry-run, and restore apply on a throwaway DB", () => {
    const { db, dbPath } = makeDatabase();
    db.close();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [scriptPath, "--db", dbPath, ...args], {
        encoding: "utf8",
      });

    const dryRun = run("--entry", "stub");
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain(
      "Newly exposed through latest affected boundary  1 message + 2 custom_message rows",
    );

    const apply = run("--entry", "stub", "--apply", "--confirm-stella-stopped");
    expect(apply.status, apply.stderr).toBe(0);
    const backupPath = /Reversible backup: (.+)$/mu.exec(apply.stdout)?.[1];
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath!, "utf8"));
    expect(backup.deletedEntries).toHaveLength(4);
    expect(backup.reparentedChildren).toHaveLength(4);

    const restoreDryRun = run("--restore", backupPath!);
    expect(restoreDryRun.status, restoreDryRun.stderr).toBe(0);
    const restoreApply = run(
      "--restore",
      backupPath!,
      "--apply",
      "--confirm-stella-stopped",
    );
    expect(restoreApply.status, restoreApply.stderr).toBe(0);

    const verified = new DatabaseSync(dbPath, { readOnly: true });
    expect(rowCount(verified, "stub")).toBe(1);
    expect(parentOf(verified, "alpha-1")).toBe("stub");
    expect(danglingParentCount(verified)).toBe(0);
    verified.close();
  });
  it("rejects an incompatible dependent range even when the dependent sorts before the target", () => {
    const { db } = makeDatabase();
    // dependent-b claims a different source range and (via a low
    // insertion_sequence) sorts BEFORE the target stub. The old
    // `affected.slice(1)` guard skipped whichever affected row happened to
    // sort first, so this incompatible dependent escaped validation.
    db.prepare(
      "UPDATE runtime_thread_entries SET data_json = ? WHERE entry_id = 'dependent-b'",
    ).run(
      JSON.stringify({
        fromEntryId: "m2",
        toEntryId: "beta-1",
        summary: dependentSummaryB,
        tokensBefore: 192_000,
      }),
    );
    db.prepare(
      "UPDATE runtime_thread_entries SET insertion_sequence = -1 WHERE entry_id = 'dependent-b'",
    ).run();

    db.exec("BEGIN IMMEDIATE");
    expect(() => analyzeRepair(db, "stub")).toThrow(
      /Dependent compaction dependent-b starts from an incompatible range/,
    );
    db.exec("ROLLBACK");
    db.close();
  });
});
