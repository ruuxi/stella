/**
 * Mid-strength per-run self-mod concurrency harness.
 *
 * Scripted agents feed deterministic mutations through the production
 * mediated-write capture, HMR controller, StoreModService, coordinator,
 * exact Git commit, morph dispatch, and HMR HTTP apply path. No LLM or API.
 */
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { METHOD_NAMES } from "../../../../runtime/protocol/index.js";
import { commitGitMessage } from "../../../../runtime/kernel/self-mod/git/commit.js";
import { getGitHead } from "../../../../runtime/kernel/self-mod/git/log.js";
import { createSelfModHmrController } from "../../../../runtime/kernel/self-mod/hmr.js";
import { StoreModService } from "../../../../runtime/kernel/self-mod/store-mod-service.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import { StoreModStore } from "../../../../runtime/kernel/storage/store-mod-store.js";
import {
  createSelfModCoordinator,
  type PendingSelfModApply,
} from "../../../../runtime/worker/self-mod-coordinator.js";
import type { WorkerPeerLike } from "../../../../runtime/worker/peer-broker.js";

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

type ApplyPayload = {
  runs: Array<{
    runId: string;
    files: Array<{ path: string; content?: string; deleted?: boolean }>;
  }>;
};

type Harness = Awaited<ReturnType<typeof createHarness>>;
const harnesses = new Set<Harness>();

const createHarness = async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-isolation-"));
  const dbRoot = await mkdtemp(path.join(os.tmpdir(), "stella-isolation-db-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "desktop", "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "desktop/src/seed.ts"),
    "export const seed = 1;\n",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "seed"]);

  const db = new DatabaseSync(getDesktopDatabasePath(dbRoot), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const service = new StoreModService(repoRoot, new StoreModStore(db));

  const hmrApplies: ApplyPayload[] = [];
  const hmrServer: Server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    if (request.url?.endsWith("/apply") && raw) {
      hmrApplies.push(JSON.parse(raw) as ApplyPayload);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, changedPaths: [] }));
  });
  await new Promise<void>((resolve) =>
    hmrServer.listen(0, "127.0.0.1", resolve),
  );
  const address = hmrServer.address();
  if (!address || typeof address === "string") throw new Error("No HMR port");

  const controller = createSelfModHmrController({
    getDevServerUrl: () => `http://127.0.0.1:${address.port}`,
    enabled: true,
    repoRoot,
  });
  const pending = new Map<string, PendingSelfModApply>();
  const hostRequests: Array<{ method: string; params: unknown }> = [];
  const peer: WorkerPeerLike = {
    notify: () => {},
    request: async <TResult>(method: string, params?: unknown) => {
      hostRequests.push({ method, params });
      return {} as TResult;
    },
    registerRequestHandler: () => {},
    registerNotificationHandler: () => {},
  };
  const coordinator = createSelfModCoordinator({
    peer,
    getController: () => controller,
    getStoreModService: () => service,
    getRuntimeStore: () => null,
    getRepoRoot: () => repoRoot,
    getPendingSelfModApplies: () => pending,
    patchSelfModApplyStatus: () => {},
  });
  const harness = {
    repoRoot,
    dbRoot,
    db,
    service,
    controller,
    coordinator,
    pending,
    hostRequests,
    hmrApplies,
    hmrServer,
  };
  harnesses.add(harness);
  return harness;
};

afterEach(async () => {
  for (const h of harnesses) {
    h.db.close();
    await new Promise<void>((resolve) => h.hmrServer.close(() => resolve()));
    await rm(h.repoRoot, { recursive: true, force: true });
    await rm(h.dbRoot, { recursive: true, force: true });
  }
  harnesses.clear();
});

const seed = async (h: Harness, file: string, content: string) => {
  const absolute = path.join(h.repoRoot, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  git(h.repoRoot, ["add", "--", file]);
  git(h.repoRoot, ["commit", "-q", "-m", `seed ${file}`]);
};

const start = async (h: Harness, runId: string) => {
  await h.controller.beginRun(runId);
  await h.coordinator.lifecycle.beginRun({
    runId,
    taskDescription: `scripted ${runId}`,
    taskPrompt: "synthetic deterministic change stream",
    conversationId: `conv-${runId}`,
    mode: "author",
  });
};

const write = async (
  h: Harness,
  runId: string,
  file: string,
  mutate: (before: string | null) => string | null,
) => {
  const absolute = path.join(h.repoRoot, file);
  const capture = await h.coordinator.lifecycle.beginMediatedWrite({
    runId,
    paths: [absolute],
  });
  await h.controller.recordWrite(runId, [absolute], { captureSnapshot: false });
  const before = await readFile(absolute, "utf8").catch(() => null);
  const after = mutate(before);
  if (after === null) {
    await rm(absolute, { force: true });
  } else {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, after);
  }
  await h.coordinator.lifecycle.finishMediatedWrite({ capture });
  await h.controller.recordWrite(runId, [absolute]);
};

const finalize = async (h: Harness, runId: string): Promise<string> => {
  await h.coordinator.lifecycle.finalizeRun({
    runId,
    taskDescription: `scripted ${runId}`,
    taskPrompt: "synthetic deterministic change stream",
    conversationId: `conv-${runId}`,
    threadKey: `thread-${runId}`,
    succeeded: true,
  });
  const entry = [...h.pending.entries()].find(
    ([, value]) => value.conversationId === `conv-${runId}`,
  );
  if (!entry) throw new Error(`No pending selector for ${runId}`);
  return entry[0];
};

const apply = async (h: Harness, selector: string) => {
  const result = await h.coordinator.applyPendingWithMorph({
    commitHash: selector,
  });
  const transitions = h.hostRequests.filter(
    (request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
  );
  if (result.applied && transitions.length > h.hmrApplies.length) {
    const transitionId = (
      transitions.at(-1)!.params as { transitionId: string }
    ).transitionId;
    await h.coordinator.resumeTransition({ transitionId });
  }
  return result;
};

const headFile = (h: Harness, file: string): string | null => {
  const result = spawnSync("git", ["show", `HEAD:${file}`], {
    cwd: h.repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : null;
};

const replace = (from: string, to: string) => (before: string | null) =>
  (before ?? "").replace(from, to);

describe("scripted self-mod concurrency matrix", () => {
  it("(a) isolates two runs on different files", async () => {
    const h = await createHarness();
    await start(h, "a");
    await start(h, "b");
    await write(h, "a", "desktop/src/a.ts", () => "export const a = 1;\n");
    await write(h, "b", "desktop/src/b.ts", () => "export const b = 1;\n");
    const a = await finalize(h, "a");
    const b = await finalize(h, "b");
    await apply(h, a);
    expect(headFile(h, "desktop/src/a.ts")).toBe("export const a = 1;\n");
    expect(headFile(h, "desktop/src/b.ts")).toBeNull();
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/b.ts"), "utf8"),
    ).toBe("export const b = 1;\n");
    expect(h.hmrApplies.at(-1)?.runs.map((run) => run.runId)).toEqual(["a"]);
    await apply(h, b);
    expect(headFile(h, "desktop/src/b.ts")).toBe("export const b = 1;\n");
  });

  it("(b,f) merges same-file disjoint regions in either apply order", async () => {
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const h = await createHarness();
      await seed(h, "desktop/src/shared.ts", "one\ntwo\nthree\n");
      await start(h, "a");
      await start(h, "b");
      await write(h, "a", "desktop/src/shared.ts", replace("one", "ONE"));
      await write(h, "b", "desktop/src/shared.ts", replace("three", "THREE"));
      const selectors = {
        a: await finalize(h, "a"),
        b: await finalize(h, "b"),
      };
      await apply(h, selectors[order[0]]);
      const first = headFile(h, "desktop/src/shared.ts")!;
      expect(first).toContain(order[0] === "a" ? "ONE" : "THREE");
      expect(first).not.toContain(order[0] === "a" ? "THREE" : "ONE");
      await apply(h, selectors[order[1]]);
      expect(headFile(h, "desktop/src/shared.ts")).toBe("ONE\ntwo\nTHREE\n");
    }
  });

  it("serializes simultaneous applies before re-reading HEAD", async () => {
    const h = await createHarness();
    await seed(h, "desktop/src/shared.ts", "one\ntwo\nthree\n");
    await start(h, "a");
    await start(h, "b");
    await write(h, "a", "desktop/src/shared.ts", replace("one", "ONE"));
    await write(h, "b", "desktop/src/shared.ts", replace("three", "THREE"));
    const a = await finalize(h, "a");
    const b = await finalize(h, "b");
    const results = await Promise.all([
      h.coordinator.applyPendingWithMorph({ commitHash: a }),
      h.coordinator.applyPendingWithMorph({ commitHash: b }),
    ]);
    expect(results.every((result) => result.applied)).toBe(true);
    expect(headFile(h, "desktop/src/shared.ts")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("(c) reports same-line concurrent authorship as an atomic conflict", async () => {
    const h = await createHarness();
    await seed(h, "desktop/src/shared.ts", "same\nkeep\n");
    await start(h, "a");
    await start(h, "b");
    await write(h, "a", "desktop/src/shared.ts", replace("same", "from-a"));
    await write(h, "b", "desktop/src/shared.ts", replace("from-a", "from-b"));
    const a = await finalize(h, "a");
    await finalize(h, "b");
    const beforeHead = await getGitHead(h.repoRoot);
    const result = await apply(h, a);
    expect(result.applied).toBe(false);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        path: "desktop/src/shared.ts",
        reason: "text-conflict",
      }),
    ]);
    expect(await getGitHead(h.repoRoot)).toBe(beforeHead);
    expect(h.hmrApplies).toHaveLength(0);
  });

  it("(d) isolates a staggered run whose base includes another run's live edit", async () => {
    const h = await createHarness();
    await seed(h, "desktop/src/shared.ts", "one\ntwo\nthree\n");
    await start(h, "a");
    await write(h, "a", "desktop/src/shared.ts", replace("one", "ONE"));
    await start(h, "b");
    await write(h, "b", "desktop/src/shared.ts", replace("three", "THREE"));
    await finalize(h, "a");
    const b = await finalize(h, "b");
    await apply(h, b);
    expect(headFile(h, "desktop/src/shared.ts")).toBe("one\ntwo\nTHREE\n");
  });

  it("(e) isolates 3+ concurrent runs", async () => {
    const h = await createHarness();
    for (const id of ["a", "b", "c", "d"]) await start(h, id);
    const selectors: string[] = [];
    for (const id of ["a", "b", "c", "d"]) {
      await write(
        h,
        id,
        `desktop/src/${id}.ts`,
        () => `export const ${id} = 1;\n`,
      );
      selectors.push(await finalize(h, id));
    }
    await apply(h, selectors[2]!);
    expect(headFile(h, "desktop/src/c.ts")).toContain("c = 1");
    expect(headFile(h, "desktop/src/a.ts")).toBeNull();
    expect(headFile(h, "desktop/src/b.ts")).toBeNull();
    expect(headFile(h, "desktop/src/d.ts")).toBeNull();
  });

  it("(g) applies one finalized run while another remains active", async () => {
    const h = await createHarness();
    await start(h, "a");
    await start(h, "b");
    await write(h, "a", "desktop/src/a.ts", () => "a\n");
    await write(h, "b", "desktop/src/b.ts", () => "b\n");
    const a = await finalize(h, "a");
    await apply(h, a);
    expect(headFile(h, "desktop/src/a.ts")).toBe("a\n");
    expect(headFile(h, "desktop/src/b.ts")).toBeNull();
    expect(h.controller.getRunStatus("b")).toBe("active");
  });

  it("(h) re-merges against a moved HEAD at apply time", async () => {
    const h = await createHarness();
    await seed(h, "desktop/src/shared.ts", "one\ntwo\nthree\n");
    await start(h, "a");
    await write(h, "a", "desktop/src/shared.ts", replace("one", "ONE"));
    const a = await finalize(h, "a");
    const moved = await commitGitMessage({
      repoRoot: h.repoRoot,
      subject: "external head move",
      files: [{ path: "desktop/src/shared.ts", content: "one\ntwo\nTHREE\n" }],
    });
    expect(moved).toBeTruthy();
    await apply(h, a);
    expect(headFile(h, "desktop/src/shared.ts")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("(i) re-apply is idempotent", async () => {
    const h = await createHarness();
    await start(h, "a");
    await write(h, "a", "desktop/src/a.ts", () => "a\n");
    const selector = await finalize(h, "a");
    await apply(h, selector);
    const head = await getGitHead(h.repoRoot);
    const second = await apply(h, selector);
    expect(second.applied).toBe(false);
    expect(await getGitHead(h.repoRoot)).toBe(head);
  });

  it("(j) explicit apply-all materializes every pending run", async () => {
    const h = await createHarness();
    for (const id of ["a", "b", "c"]) {
      await start(h, id);
      await write(h, id, `desktop/src/${id}.ts`, () => `${id}\n`);
      await finalize(h, id);
    }
    const results = await h.coordinator.applyAllPendingWithMorph();
    expect(results.every((result) => result.applied)).toBe(true);
    expect(h.pending.size).toBe(0);
    for (const id of ["a", "b", "c"]) {
      expect(headFile(h, `desktop/src/${id}.ts`)).toBe(`${id}\n`);
    }
  });

  it("(k) preserves the single-agent baseline", async () => {
    const h = await createHarness();
    await start(h, "solo");
    await write(h, "solo", "desktop/src/solo.ts", () => "solo\n");
    const selector = await finalize(h, "solo");
    const result = await apply(h, selector);
    expect(result.applied).toBe(true);
    expect(headFile(h, "desktop/src/solo.ts")).toBe("solo\n");
    expect(h.hmrApplies.at(-1)?.runs).toEqual([
      expect.objectContaining({
        runId: "solo",
        files: [{ path: "desktop/src/solo.ts", content: "solo\n" }],
      }),
    ]);
  });
});
