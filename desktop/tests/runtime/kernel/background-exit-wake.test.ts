/**
 * Exit→wake covered against real processes: every session here is a real
 * `/bin/sh` spawned through the production `startShell`, and the wake fires
 * from the actual `child.on("close")` handler. Nothing about process exit
 * is faked — only the delivery sink, so the assertion can read what a
 * resumed agent would have been handed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBackgroundExitWake,
  truncateMiddle,
  writeBackgroundExitLog,
} from "../../../../runtime/kernel/runner/background-exit-wake.js";
import {
  createShellState,
  listRunningShellSessionsOwnedBy,
  readShellExitSnapshot,
  setShellOwner,
  startShell,
  watchShellExit,
  type ShellState,
} from "../../../../runtime/kernel/tools/shell.js";

type Delivered = { conversationId: string; agentId: string; text: string };

const AGENT_ID = "thread-krea-bench";
const CONVERSATION_ID = "conv-1";

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for wake");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("background exit wake", () => {
  let dataDir: string;
  let shellState: ShellState;
  let delivered: Delivered[];
  let deliverResult: boolean;
  let threadStatus: string | undefined;
  let wake: ReturnType<typeof createBackgroundExitWake>;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-exit-wake-"));
    shellState = createShellState(dataDir);
    delivered = [];
    deliverResult = true;
    threadStatus = "completed";
    wake = createBackgroundExitWake({
      watchShellExit: (sessionId, listener) =>
        watchShellExit(shellState, sessionId, listener),
      readShellExitSnapshot: (sessionId) =>
        readShellExitSnapshot(shellState, sessionId),
      getThreadStatus: () => threadStatus,
      writeExitLog: (sessionId, contents) =>
        writeBackgroundExitLog(dataDir, sessionId, contents),
      deliver: async (payload) => {
        delivered.push(payload);
        return deliverResult;
      },
    });
  });

  afterEach(() => {
    wake.dispose();
    for (const shell of shellState.shells.values()) shell.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Start a real background command owned by the test's agent thread. */
  const startOwned = (command: string) => {
    const record = startShell(shellState, command, dataDir);
    setShellOwner(record, {
      conversationId: CONVERSATION_ID,
      deviceId: "d",
      requestId: "r",
      agentId: AGENT_ID,
      agentType: "general",
    });
    return record;
  };

  const armFor = (sessionIds: string[], interrupted = false) =>
    wake.arm({
      conversationId: CONVERSATION_ID,
      agentId: AGENT_ID,
      runningSessionIds: sessionIds,
      interrupted,
    });

  it("resumes the thread when a command left running finally exits", async () => {
    const record = startOwned("sleep 0.4; echo BENCH_DONE; exit 0");
    expect(record.running).toBe(true);
    // The agent's turn ends here, with the command still going.
    expect(armFor([record.id])).toEqual([record.id]);
    expect(delivered).toEqual([]);

    await waitFor(() => delivered.length === 1);

    const wakeText = delivered[0].text;
    expect(delivered[0].agentId).toBe(AGENT_ID);
    expect(delivered[0].conversationId).toBe(CONVERSATION_ID);
    expect(wakeText).toContain("has finished");
    expect(wakeText).toContain("sleep 0.4; echo BENCH_DONE");
    expect(wakeText).toContain("succeeded");
    expect(wakeText).toContain("BENCH_DONE");
  });

  it("reports the exit code of a command that failed", async () => {
    const record = startOwned("echo boom >&2; exit 17");
    armFor([record.id]);

    await waitFor(() => delivered.length === 1);

    expect(delivered[0].text).toContain("failed with exit code 17");
    expect(delivered[0].text).toContain("boom");
  });

  it("coalesces several exits landing together into one wake", async () => {
    const records = [
      startOwned("sleep 0.2; echo first"),
      startOwned("sleep 0.3; echo second"),
      startOwned("sleep 0.4; echo third"),
    ];
    armFor(records.map((record) => record.id));

    await waitFor(() => delivered.length === 1);
    // Give any straggler flush a chance to prove itself wrong.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain("3 commands");
    expect(delivered[0].text).toContain("first");
    expect(delivered[0].text).toContain("second");
    expect(delivered[0].text).toContain("third");
  });

  it("spills long output to a log file and cites the path", async () => {
    const record = startOwned(
      "for i in $(seq 1 4000); do echo padding-$i; done",
    );
    armFor([record.id]);

    await waitFor(() => delivered.length === 1);

    const text = delivered[0].text;
    expect(text).toContain("characters omitted");
    const match = /Full captured output: (\S+)/.exec(text);
    expect(match).not.toBeNull();
    const spilled = fs.readFileSync(match![1], "utf-8");
    expect(spilled.length).toBeGreaterThan(text.length);
    expect(spilled).toContain("padding-4000");
  });

  it("does not wake a thread the user canceled", async () => {
    threadStatus = "canceled";
    const record = startOwned("echo done");
    armFor([record.id]);

    await waitFor(() => !record.running);
    // Drive the flush the coalescing timer would run, rather than sleeping
    // out the whole 2s window.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await wake.flushNow(AGENT_ID);

    expect(delivered).toEqual([]);
    expect(wake.armedThreadIds()).toEqual([]);
  });

  it("arms nothing for an interrupted run", async () => {
    const record = startOwned("sleep 0.2");
    expect(armFor([record.id], true)).toEqual([]);

    await waitFor(() => !record.running);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(delivered).toEqual([]);
  });

  it("drops the arm once the thread is running again", async () => {
    const record = startOwned("sleep 0.3; echo late");
    armFor([record.id]);
    // The thread woke by other means (a user message, an orchestrator
    // follow-up); its next teardown re-arms whatever is still going.
    wake.disarm(AGENT_ID);

    await waitFor(() => !record.running);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(delivered).toEqual([]);
  });

  it("re-arming replaces the previous arm rather than stacking watchers", async () => {
    const record = startOwned("sleep 0.3; echo once");
    armFor([record.id]);
    armFor([record.id]);

    await waitFor(() => delivered.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(delivered).toHaveLength(1);
  });

  it("arms nothing when there is no durable thread to resume", () => {
    const record = startOwned("sleep 0.2");
    expect(
      wake.arm({
        conversationId: CONVERSATION_ID,
        runningSessionIds: [record.id],
      }),
    ).toEqual([]);
  });

  it("finds a thread's running sessions by owner, not by what a run touched", async () => {
    // Started by a turn that is long gone and never polled since.
    const stale = startOwned("sleep 5");
    const other = startShell(shellState, "sleep 5", dataDir);
    setShellOwner(other, {
      conversationId: CONVERSATION_ID,
      deviceId: "d",
      requestId: "r",
      agentId: "some-other-thread",
    });
    const finished = startOwned("true");
    await waitFor(() => !finished.running);

    const owned = listRunningShellSessionsOwnedBy(shellState, AGENT_ID);

    expect(owned).toEqual([stale.id]);
    expect(owned).not.toContain(other.id);
    expect(owned).not.toContain(finished.id);
  });

  it("stops re-arming a thread that refuses delivery", async () => {
    deliverResult = false;
    const record = startOwned("echo nope");
    armFor([record.id]);

    await waitFor(() => delivered.length === 1);

    expect(wake.armedThreadIds()).toEqual([]);
  });
});

describe("truncateMiddle", () => {
  it("keeps both ends, because the head says what ran and the tail says why it failed", () => {
    const value = `${"H".repeat(500)}${"M".repeat(5_000)}${"T".repeat(500)}`;
    const result = truncateMiddle(value, 1_000);

    expect(result.startsWith("H")).toBe(true);
    expect(result.endsWith("T")).toBe(true);
    expect(result).toContain("characters omitted");
    expect(result.length).toBeLessThan(value.length);
  });

  it("leaves short output exactly alone", () => {
    expect(truncateMiddle("short", 1_000)).toBe("short");
  });
});
