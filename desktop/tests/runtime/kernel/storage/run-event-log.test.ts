import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeDesktopDatabase } from "../../../../../runtime/kernel/storage/database-init.js";
import { RunEventLog } from "../../../../../runtime/kernel/storage/run-event-log.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

describe("RunEventLog", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let log: RunEventLog;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "stella-eventlog-"));
    const sqlitePath = path.join(tempDir, "test.sqlite");
    db = new DatabaseSync(sqlitePath, { timeout: 5000 }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    log = new RunEventLog(db);
  });

  afterEach(() => {
    log.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends and resumes events past lastSeq", () => {
    log.append({ runId: "run-1", seq: 1, payload: { type: "stream", chunk: "a" } });
    log.append({ runId: "run-1", seq: 2, payload: { type: "stream", chunk: "b" } });
    log.append({ runId: "run-1", seq: 3, payload: { type: "stream", chunk: "c" } });
    log.append({ runId: "run-2", seq: 1, payload: { type: "stream", chunk: "z" } });

    const result = log.resumeAfter({ runId: "run-1", lastSeq: 1 });
    expect(result.exhausted).toBe(false);
    expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(result.events[0]?.payload).toEqual({ type: "stream", chunk: "b" });
  });

  it("returns empty events without exhaustion when lastSeq matches the latest", () => {
    log.append({ runId: "run-1", seq: 1, payload: { type: "stream" } });
    log.append({ runId: "run-1", seq: 2, payload: { type: "stream" } });

    const result = log.resumeAfter({ runId: "run-1", lastSeq: 2 });
    expect(result.events).toEqual([]);
    expect(result.exhausted).toBe(false);
  });

  it("reports exhausted when caller is below the oldest retained seq", () => {
    log.append({ runId: "run-1", seq: 5, payload: { type: "stream" } });
    log.append({ runId: "run-1", seq: 6, payload: { type: "stream" } });

    // We pruned events 1..4 at some point (or never had them).
    const result = log.resumeAfter({ runId: "run-1", lastSeq: 1 });
    expect(result.exhausted).toBe(true);
  });

  it("ack prunes events with seq <= lastSeq", () => {
    log.append({ runId: "run-1", seq: 1, payload: { type: "stream" } });
    log.append({ runId: "run-1", seq: 2, payload: { type: "stream" } });
    log.append({ runId: "run-1", seq: 3, payload: { type: "stream" } });
    log.append({ runId: "run-1", seq: 4, payload: { type: "stream" } });

    const pruned = log.ack({ runId: "run-1", lastSeq: 2 });
    expect(pruned).toBe(2);

    const remaining = log.resumeAfter({ runId: "run-1", lastSeq: 0 });
    expect(remaining.events.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("ack on an empty log is a no-op", () => {
    expect(log.ack({ runId: "run-1", lastSeq: 5 })).toBe(0);
  });

  it("ignores duplicate (runId, seq) inserts", () => {
    expect(
      log.append({ runId: "run-1", seq: 1, payload: { v: 1 } }),
    ).toBe(true);
    expect(
      log.append({ runId: "run-1", seq: 1, payload: { v: 2 } }),
    ).toBe(false);
    const result = log.resumeAfter({ runId: "run-1", lastSeq: 0 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.payload).toEqual({ v: 1 });
  });

  it("resumes in seq order when a synthetic terminal marker arrives early", () => {
    log.append({ runId: "run-1", seq: 1, payload: { v: 1 } });
    log.append({
      runId: "run-1",
      seq: Number.MAX_SAFE_INTEGER,
      payload: { terminal: true },
    });
    log.append({ runId: "run-1", seq: 2, payload: { v: 2 } });
    log.append({ runId: "run-1", seq: 3, payload: { v: 3 } });

    const result = log.resumeAfter({ runId: "run-1", lastSeq: 0 });
    expect(result.events.map((event) => event.seq)).toEqual([
      1,
      2,
      3,
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  it("lists buffered runs with conversation ids from retained events", () => {
    log.append({
      runId: "run-1",
      seq: 1,
      payload: { conversationId: "conversation-a", type: "stream" },
      timestamp: 100,
    });
    log.append({
      runId: "run-2",
      seq: 1,
      payload: { conversationId: "conversation-b", type: "stream" },
      timestamp: 200,
    });

    expect(log.listBufferedRuns()).toEqual([
      {
        runId: "run-2",
        conversationId: "conversation-b",
        updatedAt: 200,
        hasTerminalEvent: false,
      },
      {
        runId: "run-1",
        conversationId: "conversation-a",
        updatedAt: 100,
        hasTerminalEvent: false,
      },
    ]);
  });

  it("marks buffered runs that already have terminal events", () => {
    log.append({
      runId: "run-1",
      seq: 1,
      payload: { conversationId: "conversation-a", type: "stream" },
      timestamp: 100,
    });
    log.append({
      runId: "run-1",
      seq: Number.MAX_SAFE_INTEGER,
      payload: { conversationId: "conversation-a", type: "run-finished" },
      timestamp: 200,
    });

    expect(log.listBufferedRuns()).toEqual([
      {
        runId: "run-1",
        conversationId: "conversation-a",
        updatedAt: 200,
        hasTerminalEvent: true,
      },
    ]);
  });

  it("forget drops every event for a runId", () => {
    log.append({ runId: "run-1", seq: 1, payload: {} });
    log.append({ runId: "run-1", seq: 2, payload: {} });
    log.append({ runId: "run-2", seq: 1, payload: {} });

    expect(log.forget("run-1")).toBe(2);
    expect(log.countForRun("run-1")).toBe(0);
    expect(log.countForRun("run-2")).toBe(1);
  });

  it("sweepExpired drops rows older than retention", () => {
    log.append({
      runId: "run-1",
      seq: 1,
      payload: {},
      timestamp: Date.now() - 60 * 60 * 1000,
    });
    log.append({
      runId: "run-1",
      seq: 2,
      payload: {},
      timestamp: Date.now(),
    });

    expect(log.sweepExpired(30 * 60 * 1000)).toBe(1);
    expect(log.countForRun("run-1")).toBe(1);
  });

  it("rejects malformed inputs without throwing", () => {
    expect(log.append({ runId: "", seq: 1, payload: {} })).toBe(false);
    expect(log.append({ runId: "run-1", seq: Number.NaN, payload: {} })).toBe(false);
    expect(log.ack({ runId: "", lastSeq: 1 })).toBe(0);
    expect(log.ack({ runId: "run-1", lastSeq: Number.NaN })).toBe(0);
  });
});
