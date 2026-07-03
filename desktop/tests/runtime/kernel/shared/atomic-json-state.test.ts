import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readJsonStateFile,
  updateJsonStateFile,
} from "../../../../../runtime/kernel/shared/atomic-json-state.js";
import { recordConnectorDecline } from "../../../../../runtime/kernel/connectors/connect-preferences.js";
import { listConnectorDeclines } from "../../../../../runtime/kernel/connectors/connect-preferences.js";
import { recordReminderShown } from "../../../../../runtime/kernel/runner/reminder-window-gate.js";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-atomic-json-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type Counters = { version: 1; counts: Record<string, number> };

const parseCounters = (raw: unknown): Counters => {
  const parsed = raw as Counters | undefined;
  if (parsed?.version === 1 && parsed.counts) return parsed;
  return { version: 1, counts: {} };
};

describe("updateJsonStateFile", () => {
  it("serializes concurrent read-modify-write updates without losing any", async () => {
    const filePath = path.join(makeRoot(), "nested", "state.json");
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        updateJsonStateFile({
          filePath,
          parse: parseCounters,
          update: (state) => {
            state.counts[`key-${index}`] = index;
          },
        }),
      ),
    );
    const state = await readJsonStateFile(filePath, parseCounters);
    expect(Object.keys(state.counts)).toHaveLength(25);
    // The final on-disk artifact is well-formed JSON (atomic rename, no
    // torn writes).
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toMatchObject({
      version: 1,
    });
  });

  it("recovers from a corrupt file via the parser fallback", async () => {
    const root = makeRoot();
    const filePath = path.join(root, "state.json");
    await updateJsonStateFile({
      filePath,
      parse: parseCounters,
      update: (state) => {
        state.counts.a = 1;
      },
    });
    // Corrupt it out-of-band, then update again.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "not-json", "utf-8");
    const state = await updateJsonStateFile({
      filePath,
      parse: parseCounters,
      update: (next) => {
        next.counts.b = 2;
      },
    });
    expect(state.counts).toEqual({ b: 2 });
  });
});

describe("connector state files under concurrency", () => {
  it("connect-preferences keeps every concurrent decline", async () => {
    const root = makeRoot();
    await Promise.all(
      ["gmail", "notion", "slack", "asana", "linear"].map((id) =>
        recordConnectorDecline(root, id),
      ),
    );
    expect(Object.keys(await listConnectorDeclines(root)).sort()).toEqual([
      "asana",
      "gmail",
      "linear",
      "notion",
      "slack",
    ]);
  });

  it("reminder-window state keeps every concurrent record", async () => {
    const root = makeRoot();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        recordReminderShown({
          stellaDataDir: root,
          threadKey: "conv-1",
          key: `connector-offer:svc-${index}`,
          timestamp: 1_000 + index,
        }),
      ),
    );
    const raw = JSON.parse(
      await readFile(
        path.join(root, "runtime", "reminder-window-state.json"),
        "utf-8",
      ),
    ) as { shown: Record<string, Record<string, number>> };
    expect(Object.keys(raw.shown["conv-1"] ?? {})).toHaveLength(10);
  });
});
