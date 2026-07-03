import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getLastCompactionAt,
  isReminderShownInActiveWindow,
  recordReminderShown,
} from "../../../../../runtime/kernel/runner/reminder-window-gate.js";
import { formatThreadCheckpointMessage } from "../../../../../runtime/kernel/thread-runtime.js";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-reminder-gate-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const storeWith = (
  messages: Array<{ content: string; timestamp: number }>,
) => ({
  loadThreadMessages: () => messages,
});

const checkpointAt = (timestamp: number) => ({
  content: formatThreadCheckpointMessage({
    summary: "Compacted: earlier we discussed Gmail and travel plans.",
  }),
  timestamp,
});

const KEY = "connector-offer:gmail";
const THREAD = "conv-1";

describe("reminder-window-gate", () => {
  it("is eligible before the reminder has ever been shown", async () => {
    const root = makeRoot();
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store: storeWith([{ content: "hello", timestamp: 1_000 }]),
        threadKey: THREAD,
        key: KEY,
      }),
    ).toBe(false);
  });

  it("suppresses repeats within the same active window", async () => {
    const root = makeRoot();
    await recordReminderShown({
      stellaDataDir: root,
      threadKey: THREAD,
      key: KEY,
      timestamp: 2_000,
    });
    const store = storeWith([{ content: "user: check my mail", timestamp: 1_500 }]);
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store,
        threadKey: THREAD,
        key: KEY,
      }),
    ).toBe(true);
    // A different key is unaffected.
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store,
        threadKey: THREAD,
        key: "connector-offer:notion",
      }),
    ).toBe(false);
    // A different thread is unaffected.
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store,
        threadKey: "conv-other",
        key: KEY,
      }),
    ).toBe(false);
  });

  it("becomes eligible again after a compaction checkpoint resets the window", async () => {
    const root = makeRoot();
    await recordReminderShown({
      stellaDataDir: root,
      threadKey: THREAD,
      key: KEY,
      timestamp: 2_000,
    });
    // The checkpoint summary lands AFTER the reminder was shown: the raw
    // reminder is gone from the window; the summary doesn't count.
    const store = storeWith([
      checkpointAt(3_000),
      { content: "user: what about my mail?", timestamp: 3_500 },
    ]);
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store,
        threadKey: THREAD,
        key: KEY,
      }),
    ).toBe(false);
  });

  it("keeps suppressing when the reminder was shown after the last compaction", async () => {
    const root = makeRoot();
    await recordReminderShown({
      stellaDataDir: root,
      threadKey: THREAD,
      key: KEY,
      timestamp: 4_000,
    });
    const store = storeWith([
      checkpointAt(3_000),
      { content: "user: more mail talk", timestamp: 4_500 },
    ]);
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store,
        threadKey: THREAD,
        key: KEY,
      }),
    ).toBe(true);
  });

  it("uses the latest checkpoint when several exist", () => {
    const store = storeWith([
      checkpointAt(1_000),
      { content: "middle", timestamp: 2_000 },
      checkpointAt(5_000),
    ]);
    expect(getLastCompactionAt(store, THREAD)).toBe(5_000);
  });

  it("treats an unreadable thread as never-compacted", async () => {
    const root = makeRoot();
    const store = {
      loadThreadMessages: () => {
        throw new Error("no such thread");
      },
    };
    expect(getLastCompactionAt(store, THREAD)).toBe(0);
    await recordReminderShown({
      stellaDataDir: root,
      threadKey: THREAD,
      key: KEY,
      timestamp: 1,
    });
    expect(
      await isReminderShownInActiveWindow({
        stellaDataDir: root,
        store,
        threadKey: THREAD,
        key: KEY,
      }),
    ).toBe(true);
  });
});
