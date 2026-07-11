/**
 * Mid-strength per-run self-mod concurrency harness.
 *
 * Scripted agents feed deterministic mutations through the production
 * mediated-write capture, HMR controller, StoreModService, coordinator,
 * exact Git commit, morph dispatch, and HMR HTTP apply path. No LLM or API.
 */
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { selfModHmrControl } from "../../../vite/self-mod-hmr-plugin.js";

import { METHOD_NAMES } from "../../../../runtime/protocol/index.js";
import { commitGitMessage } from "../../../../runtime/kernel/self-mod/git/commit.js";
import { getGitHead } from "../../../../runtime/kernel/self-mod/git/log.js";
import { createSelfModHmrController } from "../../../../runtime/kernel/self-mod/hmr.js";
import { getSelfModMutationLockStatus } from "../../../../runtime/kernel/self-mod/mutation-lock.js";
import { StoreModService } from "../../../../runtime/kernel/self-mod/store-mod-service.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import { StoreModStore } from "../../../../runtime/kernel/storage/store-mod-store.js";
import {
  attachPendingSelfModCards,
  createSelfModCoordinator,
  type PendingSelfModApply,
} from "../../../../runtime/worker/self-mod-coordinator.js";
import type { WorkerPeerLike } from "../../../../runtime/worker/peer-broker.js";

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

const gitBytes = (cwd: string, args: string[]): Buffer => {
  const result = spawnSync("git", args, { cwd });
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout;
};

const reservePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const createNegativeAckController = async (
  repoRoot: string,
  negativeEndpoint: "discard" | "release-client-updates",
) => {
  const port = await reservePort();
  const server = createHttpServer((request, response) => {
    request.resume();
    const negative = request.url?.endsWith(`/${negativeEndpoint}`) === true;
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: !negative }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    controller: createSelfModHmrController({
      getDevServerUrl: () => `http://127.0.0.1:${port}`,
      enabled: true,
      repoRoot,
    }),
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

type ApplyPayload = {
  runs: Array<{
    runId: string;
    protocolVersion: number;
    files: Array<{ path: string; state?: { kind: string; text?: string } }>;
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
  const previousMode = process.env.STELLA_SELF_MOD_HMR_MODE;
  process.env.STELLA_SELF_MOD_HMR_MODE = "live";
  const port = await reservePort();
  const hmrServer: ViteDevServer = await createServer({
    root: repoRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: [selfModHmrControl({ repoRoot })],
  });
  if (previousMode === undefined) delete process.env.STELLA_SELF_MOD_HMR_MODE;
  else process.env.STELLA_SELF_MOD_HMR_MODE = previousMode;
  await hmrServer.listen();
  const devServerUrl = hmrServer.resolvedUrls?.local[0];
  if (!devServerUrl) throw new Error("No Vite HMR URL");

  const controller = createSelfModHmrController({
    getDevServerUrl: () => devServerUrl,
    enabled: true,
    repoRoot,
    observeApplyPayload: (payload) => hmrApplies.push(payload as ApplyPayload),
  });
  const pending = new Map<string, PendingSelfModApply>();
  const hostRequests: Array<{ method: string; params: unknown }> = [];
  const statusPatches: Array<Record<string, unknown>> = [];
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
    patchSelfModApplyStatus: (args) => statusPatches.push(args),
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
    statusPatches,
    hmrApplies,
    hmrServer,
    devServerUrl,
    phaseAudits: [] as Array<Record<string, unknown>>,
  };
  harnesses.add(harness);
  return harness;
};

afterEach(async () => {
  for (const h of harnesses) {
    await h.controller.forceResumeAll();
    expect(await h.controller.getStatus()).toMatchObject({
      inFlightPaths: 0,
      appliedOverlayPaths: 0,
    });
    h.db.close();
    await h.hmrServer.close();
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

const auditPhase = async (h: Harness, phase: string) => {
  const head = await getGitHead(h.repoRoot);
  const index = git(h.repoRoot, ["ls-files", "--stage", "-z"]);
  const paths = git(h.repoRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter((file) => Boolean(file) && !file.startsWith(".vite/"));
  const disk = new Map<string, string>();
  for (const file of paths) {
    const absolute = path.join(h.repoRoot, file);
    const stat = await lstat(absolute).catch(() => null);
    if (!stat) {
      disk.set(file, "<missing>");
    } else if (stat.isSymbolicLink()) {
      disk.set(file, `<symlink:${await readlink(absolute)}>`);
    } else {
      disk.set(
        file,
        await readFile(absolute)
          .then((bytes) => bytes.toString("base64"))
          .catch(() => "<vanished>"),
      );
    }
  }
  const attachedCardIds = [...h.pending.values()]
    .map((pending) => pending.assistantMessageEventId)
    .filter((eventId): eventId is string => Boolean(eventId));
  expect(new Set(attachedCardIds).size).toBe(attachedCardIds.length);
  for (const payload of h.hmrApplies) {
    for (const run of payload.runs) {
      expect(run.protocolVersion).toBe(2);
      expect(run.files.every((file) => file.state)).toBe(true);
    }
  }
  const hmrStatus = await h.controller.getStatus();
  expect(hmrStatus).not.toBeNull();
  h.phaseAudits.push({
    phase,
    head,
    index,
    disk,
    pendingSelectors: [...h.pending.keys()],
    attachedCardIds,
    hmrPayloadCount: h.hmrApplies.length,
    hmrStatus,
  });
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
  await auditPhase(h, `start:${runId}`);
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
  await auditPhase(h, `write:${runId}:${file}`);
};

const mutateRaw = async (
  h: Harness,
  runId: string,
  file: string,
  mutation: (absolutePath: string) => Promise<void>,
) => {
  const absolute = path.join(h.repoRoot, file);
  const capture = await h.coordinator.lifecycle.beginMediatedWrite({
    runId,
    paths: [absolute],
  });
  await h.controller.recordWrite(runId, [absolute], { captureSnapshot: false });
  await mutation(absolute);
  await h.coordinator.lifecycle.finishMediatedWrite({ capture });
  await h.controller.recordWrite(runId, [absolute]);
  await auditPhase(h, `mutate:${runId}:${file}`);
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
  await auditPhase(h, `finalize:${runId}`);
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
  await auditPhase(h, `apply:${selector}`);
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

const persistExpiredCandidate = async (h: Harness, suffix: string) => {
  const changeSetId = `expired-${suffix}`;
  const runId = `expired-run-${suffix}`;
  const relativePath = `desktop/src/expired-${suffix}.ts`;
  const content = `export const expired = ${JSON.stringify(suffix)};\n`;
  const createdAt = Date.now() - 8 * 24 * 60 * 60 * 1_000;
  await writeFile(path.join(h.repoRoot, relativePath), content);
  new StoreModStore(h.db).upsertPendingSelfModChangeSet({
    changeSetId,
    repoRoot: h.repoRoot,
    createdAt,
    payload: {
      changeSet: {
        changeSetId,
        runId,
        createdAt,
        files: [
          {
            path: relativePath,
            base: { kind: "missing" },
            incoming: {
              kind: "blob",
              mode: "100644",
              contentBase64: Buffer.from(content).toString("base64"),
              text: content,
            },
            ranges: [{ start: 0, end: Number.MAX_SAFE_INTEGER }],
            contentChanged: true,
            modeChanged: true,
          },
        ],
        conflicts: [],
        concurrentRunIds: [],
      },
      prepared: {
        activeRun: {
          baselineDirtyFiles: [],
          taskDescription: `expired ${suffix}`,
          applyMode: "author",
        },
        subject: `expired ${suffix}`,
        trailers: {},
      },
      envelope: {
        commitHash: changeSetId,
        changeSetId,
        runId,
        conversationId: `expired-conversation-${suffix}`,
        assistantMessageEventId: `expired-card-${suffix}`,
        files: [relativePath],
        applyResult: {
          appliedRuns: [
            {
              runId,
              paths: [relativePath],
              files: [],
              runtimeRestartRelevantPaths: [],
              processRestartRelevantPaths: [],
              restartRelevantPaths: [],
              fullReloadRelevantPaths: [],
            },
          ],
          restartRelevantRunIds: [runId],
          hasRestartRelevantPaths: false,
          hasRuntimeRestartRelevantPaths: false,
          hasProcessRestartRelevantPaths: false,
          hasFullReloadRelevantPaths: false,
        },
      },
    },
  });
  return { changeSetId, runId, relativePath };
};

describe("scripted self-mod concurrency matrix", () => {
  it("(a) isolates two runs on different files", async () => {
    const h = await createHarness();
    await start(h, "a");
    await start(h, "b");
    await write(h, "a", "desktop/src/a.ts", () => "export const a = 1;\n");
    await write(h, "b", "desktop/src/b.ts", () => "export const b = 1;\n");
    const a = await finalize(h, "a");
    const b = await finalize(h, "b");
    for (const pending of h.pending.values()) {
      pending.conversationId = "conv-shared";
      h.service.persistPendingEnvelope(pending.changeSetId, pending);
    }
    const cardPayloads: Array<{ changeSetId: string }> = [];
    const cardIds = attachPendingSelfModCards({
      pending: h.pending,
      conversationId: "conv-shared",
      append: (payload) => {
        cardPayloads.push(payload);
        return `card-${payload.changeSetId}`;
      },
      persist: (pending) =>
        h.service.persistPendingEnvelope(pending.changeSetId, pending),
    });
    expect(new Set(cardIds).size).toBe(2);
    expect(cardPayloads.map((payload) => payload.changeSetId).sort()).toEqual(
      [a, b].sort(),
    );
    await apply(h, a);
    expect(headFile(h, "desktop/src/a.ts")).toBe("export const a = 1;\n");
    expect(headFile(h, "desktop/src/b.ts")).toBeNull();
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/b.ts"), "utf8"),
    ).toBe("export const b = 1;\n");
    expect(h.hmrApplies.at(-1)?.runs.map((run) => run.runId)).toEqual(["a"]);
    await apply(h, b);
    expect(headFile(h, "desktop/src/b.ts")).toBe("export const b = 1;\n");
    expect(
      h.statusPatches
        .filter((patch) => patch.status === "applied")
        .map((patch) => patch.eventId)
        .sort(),
    ).toEqual([...cardIds].sort());
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
    for (const request of h.hostRequests.filter(
      (entry) => entry.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    )) {
      await h.coordinator.resumeTransition({
        transitionId: (request.params as { transitionId: string }).transitionId,
      });
    }
    await auditPhase(h, "simultaneous-apply");
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
    const b = await finalize(h, "b");
    const beforeHead = await getGitHead(h.repoRoot);
    const beforeIndex = git(h.repoRoot, ["ls-files", "--stage", "-z"]);
    const liveBefore = await readFile(
      path.join(h.repoRoot, "desktop/src/shared.ts"),
      "utf8",
    );
    const result = await apply(h, a);
    expect(result.applied).toBe(false);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        path: "desktop/src/shared.ts",
        reason: "text-conflict",
      }),
    ]);
    expect(await getGitHead(h.repoRoot)).toBe(beforeHead);
    expect(git(h.repoRoot, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/shared.ts"), "utf8"),
    ).toBe(liveBefore);
    expect(liveBefore).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
    expect([...h.pending.keys()].sort()).toEqual([a, b].sort());
    expect(h.hmrApplies).toHaveLength(0);

    expect(await h.coordinator.discardPending({ commitHash: b })).toMatchObject(
      { discarded: true, commitHash: b },
    );
    expect(await h.controller.getStatus()).toMatchObject({ inFlightPaths: 1 });
    const retry = await apply(h, a);
    expect(retry.applied).toBe(true);
    expect(headFile(h, "desktop/src/shared.ts")).toBe("from-a\nkeep\n");
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/shared.ts"), "utf8"),
    ).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
    expect(await h.controller.getStatus()).toMatchObject({
      inFlightPaths: 0,
      appliedOverlayPaths: 0,
    });
  });

  it("discard reconstruction conflicts transactionally without ambient resurrection", async () => {
    const h = await createHarness();
    const relativePath = "desktop/src/reconstruct.ts";
    const absolutePath = path.join(h.repoRoot, relativePath);
    await seed(h, relativePath, "a0\nb0\n");
    for (const runId of ["discard", "b", "c"]) await start(h, runId);
    await write(h, "discard", relativePath, replace("a0", "A"));
    await write(h, "b", relativePath, replace("b0", "B"));
    await write(h, "c", relativePath, replace("B", "C"));
    const discardSelector = await finalize(h, "discard");
    const cSelector = await finalize(h, "c");
    const bSelector = await finalize(h, "b");
    const beforeHead = await getGitHead(h.repoRoot);
    const beforeIndex = git(h.repoRoot, ["ls-files", "--stage", "-z"]);
    const beforeDisk = await readFile(absolutePath, "utf8");

    const failed = await h.coordinator.discardPending({
      commitHash: discardSelector,
    });
    expect(failed).toMatchObject({
      discarded: false,
      conflicts: [expect.objectContaining({ path: relativePath })],
    });
    expect(await getGitHead(h.repoRoot)).toBe(beforeHead);
    expect(git(h.repoRoot, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
    expect(await readFile(absolutePath, "utf8")).toBe(beforeDisk);
    expect(beforeDisk).toBe("A\nC\n");
    expect([...h.pending.keys()].sort()).toEqual(
      [discardSelector, bSelector, cSelector].sort(),
    );
    expect(h.service.getPreparedLogicalChangeSet(discardSelector)).toBeTruthy();
    expect(
      new StoreModService(h.repoRoot, new StoreModStore(h.db))
        .listPendingEnvelopes()
        .some(
          (envelope) =>
            (envelope as { changeSetId?: string }).changeSetId ===
            discardSelector,
        ),
    ).toBe(true);

    expect(
      await h.coordinator.discardPending({ commitHash: cSelector }),
    ).toMatchObject({ discarded: true });
    expect(
      await h.coordinator.discardPending({ commitHash: discardSelector }),
    ).toMatchObject({ discarded: true });
    expect(await readFile(absolutePath, "utf8")).toBe("a0\nB\n");
    expect([...h.pending.keys()]).toEqual([bSelector]);
  });

  it("concurrent discards atomically remove both logical layers without orphaned bytes", async () => {
    const h = await createHarness();
    const sharedPath = "desktop/src/concurrent-discard.ts";
    await seed(h, sharedPath, "x-base\nmiddle\ny-base\n");
    await start(h, "discard-x");
    await start(h, "discard-y");
    await write(h, "discard-x", sharedPath, replace("x-base", "x-owned"));
    await write(h, "discard-y", sharedPath, replace("y-base", "y-owned"));
    const xSelector = await finalize(h, "discard-x");
    const ySelector = await finalize(h, "discard-y");
    const beforeHead = await getGitHead(h.repoRoot);
    const beforeIndex = git(h.repoRoot, ["ls-files", "--stage", "-z"]);

    const [xResult, yResult] = await Promise.all([
      h.coordinator.discardPending({ commitHash: xSelector }),
      h.coordinator.discardPending({ commitHash: ySelector }),
    ]);

    expect(xResult).toMatchObject({ discarded: true, commitHash: xSelector });
    expect(yResult).toMatchObject({ discarded: true, commitHash: ySelector });
    expect(await getGitHead(h.repoRoot)).toBe(beforeHead);
    expect(git(h.repoRoot, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
    expect(await readFile(path.join(h.repoRoot, sharedPath), "utf8")).toBe(
      "x-base\nmiddle\ny-base\n",
    );
    expect(h.pending.size).toBe(0);
    expect(h.service.getPreparedLogicalChangeSet(xSelector)).toBeNull();
    expect(h.service.getPreparedLogicalChangeSet(ySelector)).toBeNull();
    expect(
      new StoreModStore(h.db).listPendingSelfModChangeSets(h.repoRoot),
    ).toHaveLength(0);
    expect(await h.controller.getStatus()).toMatchObject({
      inFlightPaths: 0,
      appliedOverlayPaths: 0,
    });
  });

  it("concurrent duplicate discard has one owner and remains idempotent", async () => {
    const h = await createHarness();
    const relativePath = "desktop/src/duplicate-discard.ts";
    await seed(h, relativePath, "base\n");
    await start(h, "duplicate-discard");
    await write(h, "duplicate-discard", relativePath, () => "owned\n");
    const selector = await finalize(h, "duplicate-discard");

    const results = await Promise.all([
      h.coordinator.discardPending({ commitHash: selector }),
      h.coordinator.discardPending({ commitHash: selector }),
    ]);

    expect(results.map((result) => result.discarded).sort()).toEqual([
      false,
      true,
    ]);
    expect(await readFile(path.join(h.repoRoot, relativePath), "utf8")).toBe(
      "base\n",
    );
    expect(h.pending.size).toBe(0);
    expect(h.service.getPreparedLogicalChangeSet(selector)).toBeNull();
    expect(
      new StoreModStore(h.db).listPendingSelfModChangeSets(h.repoRoot),
    ).toHaveLength(0);
  });

  it("releases the transaction queue and mutation lock after a thrown discard", async () => {
    const h = await createHarness();
    const relativePath = "desktop/src/blocked/queue-release.ts";
    const absolutePath = path.join(h.repoRoot, relativePath);
    await seed(h, relativePath, "base\n");
    await start(h, "queue-release");
    await write(h, "queue-release", relativePath, () => "owned\n");
    const selector = await finalize(h, "queue-release");
    await rm(path.dirname(absolutePath), { recursive: true, force: true });
    await writeFile(path.dirname(absolutePath), "not-a-directory\n");

    await expect(
      h.coordinator.discardPending({ commitHash: selector }),
    ).rejects.toThrow();
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
    expect(h.pending.has(selector)).toBe(true);
    expect(h.service.getPreparedLogicalChangeSet(selector)).toBeTruthy();

    await rm(path.dirname(absolutePath), { force: true });
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "owned\n");
    expect(
      await h.coordinator.discardPending({ commitHash: selector }),
    ).toMatchObject({ discarded: true });
    expect(await readFile(absolutePath, "utf8")).toBe("base\n");
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
  });

  it("process-restart reconstruction returns a structured conflict and retries", async () => {
    const h = await createHarness();
    await writeFile(path.join(h.repoRoot, "package.json"), '{"name":"old"}\n');
    await seed(h, "desktop/src/restart-conflict.ts", "same\n");
    git(h.repoRoot, ["add", "package.json"]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed restart package"]);
    for (const runId of ["restart", "b", "c"]) await start(h, runId);
    await write(h, "restart", "package.json", () => '{"name":"new"}\n');
    await write(
      h,
      "b",
      "desktop/src/restart-conflict.ts",
      replace("same", "B"),
    );
    await write(h, "c", "desktop/src/restart-conflict.ts", replace("B", "C"));
    const restartSelector = await finalize(h, "restart");
    const cSelector = await finalize(h, "c");
    await finalize(h, "b");
    expect(
      await h.coordinator.applyPendingWithMorph({
        commitHash: restartSelector,
      }),
    ).toMatchObject({ applied: true });
    const transition = h.hostRequests.find(
      (request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    )!;
    const diskBefore = await readFile(
      path.join(h.repoRoot, "desktop/src/restart-conflict.ts"),
      "utf8",
    );
    const firstResume = await h.coordinator.resumeTransition({
      transitionId: (transition.params as { transitionId: string })
        .transitionId,
    });
    expect(firstResume).toMatchObject({
      ok: false,
      reason: "reconstruction-conflict",
      conflicts: [
        expect.objectContaining({ path: "desktop/src/restart-conflict.ts" }),
      ],
    });
    expect(
      await readFile(
        path.join(h.repoRoot, "desktop/src/restart-conflict.ts"),
        "utf8",
      ),
    ).toBe(diskBefore);
    expect(
      await h.coordinator.discardPending({ commitHash: cSelector }),
    ).toMatchObject({ discarded: true });
    expect(
      await h.coordinator.resumeTransition({
        transitionId: (transition.params as { transitionId: string })
          .transitionId,
      }),
    ).toMatchObject({ ok: true });
    expect(await readFile(path.join(h.repoRoot, "package.json"), "utf8")).toBe(
      '{"name":"new"}\n',
    );
    expect(
      await readFile(
        path.join(h.repoRoot, "desktop/src/restart-conflict.ts"),
        "utf8",
      ),
    ).toBe("B\n");
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
      files: [
        {
          path: "desktop/src/shared.ts",
          state: {
            kind: "blob",
            mode: "100644",
            contentBase64: Buffer.from("one\ntwo\nTHREE\n").toString("base64"),
            text: "one\ntwo\nTHREE\n",
          },
        },
      ],
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
    for (const request of h.hostRequests.filter(
      (entry) => entry.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    )) {
      await h.coordinator.resumeTransition({
        transitionId: (request.params as { transitionId: string }).transitionId,
      });
    }
    await auditPhase(h, "apply-all");
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
        protocolVersion: 2,
        files: [
          expect.objectContaining({
            path: "desktop/src/solo.ts",
            state: expect.objectContaining({ text: "solo\n" }),
          }),
        ],
      }),
    ]);
  });

  it("preserves binary bytes, executable modes, and symlink objects", async () => {
    const h = await createHarness();
    await mkdir(path.join(h.repoRoot, "runtime/worker"), { recursive: true });
    await writeFile(
      path.join(h.repoRoot, "runtime/worker/binary.bin"),
      Buffer.from([0, 1, 2]),
    );
    await writeFile(
      path.join(h.repoRoot, "runtime/worker/tool.sh"),
      "#!/bin/sh\necho old\n",
    );
    await chmod(path.join(h.repoRoot, "runtime/worker/tool.sh"), 0o644);
    await writeFile(path.join(h.repoRoot, "runtime/worker/target-a.ts"), "a\n");
    await writeFile(path.join(h.repoRoot, "runtime/worker/target-b.ts"), "b\n");
    await symlink(
      "target-a.ts",
      path.join(h.repoRoot, "runtime/worker/link.ts"),
    );
    git(h.repoRoot, ["add", "runtime/worker"]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed raw states"]);

    await start(h, "raw");
    await mutateRaw(h, "raw", "runtime/worker/binary.bin", async (absolute) => {
      await writeFile(absolute, Buffer.from([0, 255, 254, 3]));
    });
    await mutateRaw(h, "raw", "runtime/worker/tool.sh", async (absolute) => {
      await chmod(absolute, 0o755);
    });
    await mutateRaw(h, "raw", "runtime/worker/link.ts", async (absolute) => {
      await rm(absolute);
      await symlink("target-b.ts", absolute);
    });
    const selector = await finalize(h, "raw");
    expect((await apply(h, selector)).applied).toBe(true);

    expect(
      gitBytes(h.repoRoot, ["show", "HEAD:runtime/worker/binary.bin"]),
    ).toEqual(Buffer.from([0, 255, 254, 3]));
    expect(
      git(h.repoRoot, ["ls-tree", "HEAD", "runtime/worker/tool.sh"]),
    ).toMatch(/^100755 /);
    expect(
      git(h.repoRoot, ["ls-tree", "HEAD", "runtime/worker/link.ts"]),
    ).toMatch(/^120000 /);
    expect(
      await readlink(path.join(h.repoRoot, "runtime/worker/link.ts")),
    ).toBe("target-b.ts");
    expect(
      (
        await lstat(path.join(h.repoRoot, "runtime/worker/link.ts"))
      ).isSymbolicLink(),
    ).toBe(true);
  });

  it("preserves a user-staged selected-path index entry", async () => {
    const h = await createHarness();
    await seed(h, "desktop/src/staged.ts", "base\n");
    const absolute = path.join(h.repoRoot, "desktop/src/staged.ts");
    await writeFile(absolute, "user staged\n");
    git(h.repoRoot, ["add", "desktop/src/staged.ts"]);
    await writeFile(absolute, "base\n");

    await start(h, "agent");
    await write(h, "agent", "desktop/src/staged.ts", () => "agent\n");
    const selector = await finalize(h, "agent");
    expect((await apply(h, selector)).applied).toBe(true);
    expect(headFile(h, "desktop/src/staged.ts")).toBe("agent\n");
    expect(git(h.repoRoot, ["show", ":desktop/src/staged.ts"])).toBe(
      "user staged\n",
    );
  });

  it("merges a chmod-only delta with another run's text hunk", async () => {
    const h = await createHarness();
    await mkdir(path.join(h.repoRoot, "runtime/worker"), { recursive: true });
    const relative = "runtime/worker/mode-and-text.sh";
    const absolute = path.join(h.repoRoot, relative);
    await writeFile(absolute, "#!/bin/sh\necho old\n", { mode: 0o644 });
    git(h.repoRoot, ["add", relative]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed mode merge"]);
    await start(h, "mode");
    await start(h, "text");
    await mutateRaw(h, "mode", relative, async (file) => chmod(file, 0o755));
    await write(h, "text", relative, replace("old", "new"));
    const modeSelector = await finalize(h, "mode");
    const textSelector = await finalize(h, "text");
    expect((await apply(h, textSelector)).applied).toBe(true);
    expect(headFile(h, relative)).toBe("#!/bin/sh\necho new\n");
    expect(git(h.repoRoot, ["ls-tree", "HEAD", relative])).toMatch(/^100644 /);
    expect((await apply(h, modeSelector)).applied).toBe(true);
    expect(headFile(h, relative)).toBe("#!/bin/sh\necho new\n");
    expect(git(h.repoRoot, ["ls-tree", "HEAD", relative])).toMatch(/^100755 /);
  });

  it("sends explicit noop states in the versioned HMR protocol", async () => {
    const h = await createHarness();
    await seed(h, "runtime/worker/restart.ts", "old\n");
    await seed(h, "desktop/src/noop.ts", "same\n");
    await start(h, "noop");
    await write(h, "noop", "runtime/worker/restart.ts", () => "new\n");
    await h.controller.recordWrite(
      "noop",
      [path.join(h.repoRoot, "desktop/src/noop.ts")],
      { captureSnapshot: false },
    );
    const selector = await finalize(h, "noop");
    expect((await apply(h, selector)).applied).toBe(true);
    const payload = h.hmrApplies.at(-1);
    expect(payload?.runs[0]).toMatchObject({ protocolVersion: 2 });
    expect(payload?.runs[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "desktop/src/noop.ts",
          state: expect.objectContaining({ kind: "blob", text: "same\n" }),
        }),
      ]),
    );
  });

  it("rebuilds process-restart disk as applied HEAD plus every live delta", async () => {
    const h = await createHarness();
    await writeFile(path.join(h.repoRoot, "package.json"), '{"name":"old"}\n');
    git(h.repoRoot, ["add", "package.json"]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed package"]);
    await start(h, "x");
    await start(h, "y");
    await write(h, "x", "package.json", () => '{"name":"x"}\n');
    await write(h, "y", "desktop/src/y.ts", () => "export const y = true;\n");
    const x = await finalize(h, "x");
    await finalize(h, "y");
    expect((await apply(h, x)).applied).toBe(true);
    expect(headFile(h, "package.json")).toBe('{"name":"x"}\n');
    expect(headFile(h, "desktop/src/y.ts")).toBeNull();
    expect(await readFile(path.join(h.repoRoot, "package.json"), "utf8")).toBe(
      '{"name":"x"}\n',
    );
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/y.ts"), "utf8"),
    ).toBe("export const y = true;\n");
  });

  it("restores a pending selector and logical snapshot after worker restart", async () => {
    const h = await createHarness();
    await start(h, "persisted");
    await write(
      h,
      "persisted",
      "desktop/src/persisted.ts",
      () => "persisted\n",
    );
    const selector = await finalize(h, "persisted");
    expect(h.service.listPendingEnvelopes()).toHaveLength(1);

    const restoredService = new StoreModService(
      h.repoRoot,
      new StoreModStore(h.db),
    );
    const restoredPayloads: ApplyPayload[] = [];
    const restoredController = createSelfModHmrController({
      getDevServerUrl: () => h.devServerUrl,
      enabled: true,
      repoRoot: h.repoRoot,
      observeApplyPayload: (payload) =>
        restoredPayloads.push(payload as ApplyPayload),
    });
    const restoredPending = new Map<string, PendingSelfModApply>();
    const restoredRequests: Array<{ method: string; params: unknown }> = [];
    const restoredCoordinator = createSelfModCoordinator({
      peer: {
        notify: () => {},
        request: async <TResult>(method: string, params?: unknown) => {
          restoredRequests.push({ method, params });
          return { ok: true } as TResult;
        },
        registerRequestHandler: () => {},
        registerNotificationHandler: () => {},
      },
      getController: () => restoredController,
      getStoreModService: () => restoredService,
      getRuntimeStore: () => null,
      getRepoRoot: () => h.repoRoot,
      getPendingSelfModApplies: () => restoredPending,
      patchSelfModApplyStatus: () => {},
    });
    await restoredCoordinator.restorePending(
      restoredService.listPendingEnvelopes(),
    );
    expect([...restoredPending.keys()]).toEqual([selector]);
    expect(
      await restoredCoordinator.applyPendingWithMorph({ commitHash: selector }),
    ).toMatchObject({ applied: true });
    const transition = restoredRequests.find(
      (request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    );
    expect(transition).toBeTruthy();
    await restoredCoordinator.resumeTransition({
      transitionId: (transition!.params as { transitionId: string })
        .transitionId,
    });
    expect(headFile(h, "desktop/src/persisted.ts")).toBe("persisted\n");
    expect(restoredPayloads.at(-1)?.runs[0]?.protocolVersion).toBe(2);
    expect(
      new StoreModService(
        h.repoRoot,
        new StoreModStore(h.db),
      ).listPendingEnvelopes(),
    ).toHaveLength(0);
  });

  it("enforces TTL and the 64-row cap before restoring HMR ownership", async () => {
    const h = await createHarness();
    const store = new StoreModStore(h.db);
    const now = Date.now();
    const ids: string[] = [];
    for (let index = 0; index < 67; index += 1) {
      const changeSetId = `retained-${String(index).padStart(2, "0")}`;
      const runId = `restore-run-${index}`;
      const relativePath = `desktop/src/restore-${index}.ts`;
      const content = `export const restored = ${index};\n`;
      const createdAt =
        index === 0 ? now - 8 * 24 * 60 * 60 * 1_000 : now - 10_000 + index;
      ids.push(changeSetId);
      await writeFile(path.join(h.repoRoot, relativePath), content);
      store.upsertPendingSelfModChangeSet({
        changeSetId,
        repoRoot: h.repoRoot,
        createdAt,
        payload: {
          changeSet: {
            changeSetId,
            runId,
            createdAt,
            files: [
              {
                path: relativePath,
                base: { kind: "missing" },
                incoming: {
                  kind: "blob",
                  mode: "100644",
                  contentBase64: Buffer.from(content).toString("base64"),
                  text: content,
                },
                ranges: [{ start: 0, end: Number.MAX_SAFE_INTEGER }],
                contentChanged: true,
                modeChanged: true,
              },
            ],
            conflicts: [],
            concurrentRunIds: [],
          },
          prepared: {
            activeRun: {
              baselineDirtyFiles: [],
              taskDescription: `restore ${index}`,
              applyMode: "author",
            },
            subject: `restore ${index}`,
            trailers: {},
            conversationTrailer: `restore-conversation-${index}`,
          },
          envelope: {
            commitHash: changeSetId,
            changeSetId,
            runId,
            conversationId: `restore-conversation-${index}`,
            assistantMessageEventId: `restore-card-${index}`,
            files: [relativePath],
            applyResult: {
              appliedRuns: [
                {
                  runId,
                  paths: [relativePath],
                  files: [],
                  runtimeRestartRelevantPaths: [],
                  processRestartRelevantPaths: [],
                  restartRelevantPaths: [],
                  fullReloadRelevantPaths: [],
                },
              ],
              restartRelevantRunIds: [runId],
              hasRestartRelevantPaths: false,
              hasRuntimeRestartRelevantPaths: false,
              hasProcessRestartRelevantPaths: false,
              hasFullReloadRelevantPaths: false,
            },
          },
        },
      });
    }

    const restoredService = new StoreModService(h.repoRoot, store);
    expect(restoredService.listPendingChangeSetIds()).toHaveLength(64);
    expect(
      restoredService
        .listStartupDiscardCandidates()
        .map((candidate) => candidate.changeSetId),
    ).toEqual(ids.slice(0, 3));

    const restoredPending = new Map<string, PendingSelfModApply>();
    const restoredRequests: Array<{ method: string; params: unknown }> = [];
    const restoredPatches: Array<Record<string, unknown>> = [];
    const restoredCoordinator = createSelfModCoordinator({
      peer: {
        notify: () => {},
        request: async <TResult>(method: string, params?: unknown) => {
          restoredRequests.push({ method, params });
          return { ok: true } as TResult;
        },
        registerRequestHandler: () => {},
        registerNotificationHandler: () => {},
      },
      getController: () => h.controller,
      getStoreModService: () => restoredService,
      getRuntimeStore: () => null,
      getRepoRoot: () => h.repoRoot,
      getPendingSelfModApplies: () => restoredPending,
      patchSelfModApplyStatus: (args) => restoredPatches.push(args),
    });
    expect(
      restoredRequests.filter(
        (request) => request.method === METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE,
      ),
    ).toHaveLength(0);
    expect(
      await restoredCoordinator.cleanupStartupDiscardCandidates(
        restoredService.listStartupDiscardCandidates(),
      ),
    ).toEqual({
      status: "applied",
      completedChangeSetIds: ids.slice(0, 3),
      retryChangeSetIds: [],
    });
    for (const index of [0, 1, 2]) {
      await expect(
        readFile(path.join(h.repoRoot, `desktop/src/restore-${index}.ts`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      restoredPatches.filter((patch) => patch.status === "discarded"),
    ).toHaveLength(3);

    await restoredCoordinator.restorePending(
      restoredService.listPendingEnvelopes(),
    );
    expect(restoredPending.size).toBe(64);
    expect(
      [...restoredPending.keys()].some((id) => ids.slice(0, 3).includes(id)),
    ).toBe(false);
    const pausedRunIds = restoredRequests
      .filter(
        (request) => request.method === METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE,
      )
      .map((request) => (request.params as { runId: string }).runId);
    expect(pausedRunIds).toHaveLength(64);
    expect(pausedRunIds).not.toContain("restore-run-0");
    expect(
      new StoreModStore(h.db).listPendingSelfModChangeSets(h.repoRoot),
    ).toHaveLength(64);
  });

  it.each([
    "vite-discard-negative",
    "vite-release-negative",
    "host-reload-negative",
    "host-reload-rejected",
  ] as const)(
    "retains startup cleanup persistence when %s is not affirmative",
    async (failure) => {
      const h = await createHarness();
      const candidate = await persistExpiredCandidate(h, failure);
      const restoredService = new StoreModService(
        h.repoRoot,
        new StoreModStore(h.db),
      );
      const candidates = restoredService.listStartupDiscardCandidates();
      expect(candidates.map((entry) => entry.changeSetId)).toEqual([
        candidate.changeSetId,
      ]);
      const patches: Array<Record<string, unknown>> = [];
      const negativeVite = failure.startsWith("vite-")
        ? await createNegativeAckController(
            h.repoRoot,
            failure === "vite-discard-negative"
              ? "discard"
              : "release-client-updates",
          )
        : null;
      const failingCoordinator = createSelfModCoordinator({
        peer: {
          notify: () => {},
          request: async <TResult>(method: string) => {
            if (method === METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME) {
              if (failure === "host-reload-negative") {
                return { ok: false } as TResult;
              }
              if (failure !== "host-reload-rejected") {
                return { ok: true } as TResult;
              }
              throw new Error("synthetic reload transport failure");
            }
            return { ok: true } as TResult;
          },
          registerRequestHandler: () => {},
          registerNotificationHandler: () => {},
        },
        getController: () => negativeVite?.controller ?? h.controller,
        getStoreModService: () => restoredService,
        getRuntimeStore: () => null,
        getRepoRoot: () => h.repoRoot,
        getPendingSelfModApplies: () => new Map(),
        patchSelfModApplyStatus: (args) => patches.push(args),
      });

      try {
        expect(
          await failingCoordinator.cleanupStartupDiscardCandidates(candidates),
        ).toEqual({
          status: "applied",
          completedChangeSetIds: [],
          retryChangeSetIds: [candidate.changeSetId],
        });
      } finally {
        await negativeVite?.close();
      }
      expect(
        new StoreModStore(h.db)
          .listPendingSelfModChangeSets(h.repoRoot)
          .map((row) => row.changeSetId),
      ).toEqual([candidate.changeSetId]);
      expect(
        restoredService
          .listStartupDiscardCandidates()
          .map((entry) => entry.changeSetId),
      ).toEqual([candidate.changeSetId]);
      expect(patches).toHaveLength(0);
      await expect(
        readFile(path.join(h.repoRoot, candidate.relativePath)),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const retryCoordinator = createSelfModCoordinator({
        peer: {
          notify: () => {},
          request: async <TResult>() => ({ ok: true }) as TResult,
          registerRequestHandler: () => {},
          registerNotificationHandler: () => {},
        },
        getController: () => h.controller,
        getStoreModService: () => restoredService,
        getRuntimeStore: () => null,
        getRepoRoot: () => h.repoRoot,
        getPendingSelfModApplies: () => new Map(),
        patchSelfModApplyStatus: (args) => patches.push(args),
      });
      expect(
        await retryCoordinator.cleanupStartupDiscardCandidates(
          restoredService.listStartupDiscardCandidates(),
        ),
      ).toEqual({
        status: "applied",
        completedChangeSetIds: [candidate.changeSetId],
        retryChangeSetIds: [],
      });
      expect(
        new StoreModStore(h.db).listPendingSelfModChangeSets(h.repoRoot),
      ).toHaveLength(0);
      expect(restoredService.listStartupDiscardCandidates()).toHaveLength(0);
      expect(patches).toEqual([
        expect.objectContaining({
          commitHash: candidate.changeSetId,
          status: "discarded",
        }),
      ]);
    },
  );
});
