/**
 * Worker self-mod coordinator scenarios against a REAL git repo and a
 * stubbed Electron host peer: agent finalize → pending "Update" card →
 * user apply → host resume; inline undo (revert) with the revert-notice
 * ledger; and the external (store/source-import) lifecycle envelope.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { METHOD_NAMES } from "../../../../runtime/protocol/index.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import { SessionStore } from "../../../../runtime/kernel/storage/session-store.js";
import type { RuntimeStore } from "../../../../runtime/kernel/storage/runtime-store.js";
import { StoreModStore } from "../../../../runtime/kernel/storage/store-mod-store.js";
import { StoreModService } from "../../../../runtime/kernel/self-mod/store-mod-service.js";
import {
  createSelfModHmrController,
  type SelfModHmrController,
} from "../../../../runtime/kernel/self-mod/hmr.js";
import {
  getGitHead,
  listGitDirtyFiles,
} from "../../../../runtime/kernel/self-mod/git/log.js";
import {
  createSelfModCoordinator,
  type PendingSelfModApply,
  type SelfModCoordinator,
} from "../../../../runtime/worker/self-mod-coordinator.js";
import type { WorkerPeerLike } from "../../../../runtime/worker/peer-broker.js";

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

type RecordedRequest = { method: string; params: unknown };

type Harness = {
  repoRoot: string;
  dbRoot: string;
  db: SqliteDatabase;
  service: StoreModService;
  sessionStore: SessionStore;
  controller: SelfModHmrController;
  coordinator: SelfModCoordinator;
  pendingApplies: Map<string, PendingSelfModApply>;
  requests: RecordedRequest[];
  statusPatches: Array<{
    conversationId: string;
    commitHash: string;
    status: "pending" | "applied";
  }>;
};

const harnesses = new Set<Harness>();

const createHarness = async (): Promise<Harness> => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-coord-"));
  const dbRoot = await mkdtemp(path.join(os.tmpdir(), "stella-coord-db-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "desktop", "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "desktop", "src", "seed.tsx"),
    "export const seed = 1;\n",
    "utf8",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "Initial seed"]);

  const db = new DatabaseSync(getDesktopDatabasePath(dbRoot), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const service = new StoreModService(repoRoot, new StoreModStore(db));
  const sessionStore = new SessionStore(db);

  const requests: RecordedRequest[] = [];
  const peer: WorkerPeerLike = {
    notify: () => {},
    request: async <TResult>(method: string, params?: unknown) => {
      requests.push({ method, params });
      return { ok: true } as TResult;
    },
    registerRequestHandler: () => {},
    registerNotificationHandler: () => {},
  };

  const controller = createSelfModHmrController({
    getDevServerUrl: () => "http://127.0.0.1:1",
    enabled: false,
    repoRoot,
  });
  const pendingApplies = new Map<string, PendingSelfModApply>();
  const statusPatches: Harness["statusPatches"] = [];

  const coordinator = createSelfModCoordinator({
    peer,
    getController: () => controller,
    getStoreModService: () => service,
    getRuntimeStore: () => sessionStore as unknown as RuntimeStore,
    getRepoRoot: () => repoRoot,
    getPendingSelfModApplies: () => pendingApplies,
    patchSelfModApplyStatus: (args) => {
      statusPatches.push({
        conversationId: args.conversationId,
        commitHash: args.commitHash,
        status: args.status,
      });
    },
  });

  const harness: Harness = {
    repoRoot,
    dbRoot,
    db,
    service,
    sessionStore,
    controller,
    coordinator,
    pendingApplies,
    requests,
    statusPatches,
  };
  harnesses.add(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses) {
    harness.db.close();
    await rm(harness.repoRoot, { recursive: true, force: true });
    await rm(harness.dbRoot, { recursive: true, force: true });
  }
  harnesses.clear();
});

const methodsOf = (h: Harness, method: string): RecordedRequest[] =>
  h.requests.filter((request) => request.method === method);

const pausedRunIds = (h: Harness): string[] =>
  methodsOf(h, METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE).map(
    (request) => (request.params as { runId: string }).runId,
  );

const resumedRunIds = (h: Harness): string[] =>
  methodsOf(h, METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME).map(
    (request) => (request.params as { runId: string }).runId,
  );

const writeRepoFile = async (h: Harness, relPath: string, content: string) => {
  await mkdir(path.dirname(path.join(h.repoRoot, relPath)), {
    recursive: true,
  });
  await writeFile(path.join(h.repoRoot, relPath), content, "utf8");
};

const runAgentSelfMod = async (
  h: Harness,
  runId: string,
  relPath: string,
  content: string,
  conversationId: string,
  mode:
    | "author"
    | "install"
    | "update"
    | "uninstall"
    | "desktop-update" = "author",
) => {
  // The orchestration layer registers the run with the HMR controller
  // before any writes; the coordinator lifecycle snapshots the git
  // baseline. It also always resolves a mode ("author" for general-agent
  // runs). Mirror that here.
  await h.controller.beginRun(runId);
  await h.coordinator.lifecycle.beginRun({
    runId,
    taskDescription: `Task ${runId}`,
    taskPrompt: "prompt",
    conversationId,
    mode,
  });
  await writeRepoFile(h, relPath, content);
  await h.controller.recordWrite(runId, [path.join(h.repoRoot, relPath)]);
  await h.coordinator.lifecycle.finalizeRun({
    runId,
    taskDescription: `Task ${runId}`,
    taskPrompt: "prompt",
    conversationId,
    threadKey: `thread-${runId}`,
    succeeded: true,
  });
};

describe("self-mod coordinator", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("agent finalize stashes a pending apply behind the Update card instead of auto-applying", async () => {
    await runAgentSelfMod(
      h,
      "run-1",
      "desktop/src/feature.tsx",
      "export const feature = true;\n",
      "conv-1",
    );

    // Commit landed on disk…
    const head = (await getGitHead(h.repoRoot))!;
    expect(git(h.repoRoot, ["show", "-s", "--format=%B", head])).toContain(
      "Stella-Conversation: conv-1",
    );
    // …and the apply is parked behind the pending card, keyed by commit.
    expect([...h.pendingApplies.keys()]).toEqual([head]);
    const pending = h.pendingApplies.get(head)!;
    expect(pending.commitHash).toBe(head);
    expect(pending.conversationId).toBe("conv-1");
    expect(pending.files).toEqual(["desktop/src/feature.tsx"]);
    // No morph transition was raised and the reload pause is still held.
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(0);
    expect(pausedRunIds(h)).toEqual(["run-1"]);
    expect(resumedRunIds(h)).toEqual([]);
    expect(h.coordinator.hasPendingApplyBatches()).toBe(false);
  });

  it("store install finalize auto-applies through the morph instead of stashing a card", async () => {
    // Store install/update/uninstall agent fallbacks run in background
    // `store-install:<pkg>` conversations with no chat surface, so there
    // is no Update card to click — they must dispatch immediately.
    await runAgentSelfMod(
      h,
      "run-install",
      "desktop/src/mod.tsx",
      "export const mod = true;\n",
      "store-install:pkg-a",
      "install",
    );

    expect(h.pendingApplies.size).toBe(0);
    const transitions = methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION);
    expect(transitions).toHaveLength(1);
    const transitionId = (transitions[0]!.params as { transitionId: string })
      .transitionId;
    const resume = await h.coordinator.resumeTransition({ transitionId });
    expect(resume).toEqual({ ok: true, requiresClientFullReload: false });
    expect(resumedRunIds(h)).toEqual(["run-install"]);
  });

  it("reports an already-completed desktop-update transition without morphing twice", async () => {
    await runAgentSelfMod(
      h,
      "run-desktop-update",
      "desktop/src/desktop-update.tsx",
      "export const updated = true;\n",
      "install-update-conversation",
      "desktop-update",
    );
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(1);

    const result = await h.coordinator.externalLifecycle.finishExternalSelfMod({
      runId: "run-desktop-update",
      succeeded: true,
    });

    expect(result).toEqual({ ok: true, transitioned: true });
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(1);
  });

  it("clicking Update drains pending applies through one morph transition and resumes reload pauses", async () => {
    await runAgentSelfMod(
      h,
      "run-1",
      "desktop/src/one.tsx",
      "export const one = 1;\n",
      "conv-1",
    );
    const firstHead = (await getGitHead(h.repoRoot))!;
    await runAgentSelfMod(
      h,
      "run-2",
      "desktop/src/two.tsx",
      "export const two = 2;\n",
      "conv-1",
    );
    const secondHead = (await getGitHead(h.repoRoot))!;
    expect(h.pendingApplies.size).toBe(2);

    const applyResult = await h.coordinator.applyPendingWithMorph({
      commitHash: secondHead,
    });
    expect(applyResult).toEqual({ commitHash: secondHead, applied: true });
    // Both pending entries drained into ONE merged transition.
    const transitions = methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION);
    expect(transitions).toHaveLength(1);
    expect(h.pendingApplies.size).toBe(0);
    expect(h.statusPatches).toEqual([
      { conversationId: "conv-1", commitHash: firstHead, status: "applied" },
      { conversationId: "conv-1", commitHash: secondHead, status: "applied" },
    ]);
    expect(h.coordinator.hasPendingApplyBatches()).toBe(true);

    // Host raised the cover and calls back; the worker applies + releases.
    const transitionId = (transitions[0]!.params as { transitionId: string })
      .transitionId;
    const resume = await h.coordinator.resumeTransition({ transitionId });
    expect(resume).toEqual({ ok: true, requiresClientFullReload: false });
    expect(h.coordinator.hasPendingApplyBatches()).toBe(false);
    expect(new Set(resumedRunIds(h))).toEqual(new Set(["run-1", "run-2"]));
  });

  it("a stale resumeTransition releases the host-echoed reload pauses", async () => {
    const result = await h.coordinator.resumeTransition({
      transitionId: "gone",
      runIds: ["stale-run"],
    });
    expect(result).toEqual({ ok: false, reason: "unknown-transition" });
    expect(resumedRunIds(h)).toEqual(["stale-run"]);
  });

  it("inline undo reverts the commit, records the revert-notice ledger row, and morphs the revert", async () => {
    await runAgentSelfMod(
      h,
      "run-undo",
      "desktop/src/undo.tsx",
      "export const undo = 1;\n",
      "conv-undo",
    );
    const head = (await getGitHead(h.repoRoot))!;
    // Adopt the pending change first (the user clicked Update earlier).
    await h.coordinator.applyPendingWithMorph({ commitHash: head });
    const adoptTransition = (
      methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)[0]!.params as {
        transitionId: string;
      }
    ).transitionId;
    await h.coordinator.resumeTransition({ transitionId: adoptTransition });

    const result = await h.coordinator.revertWithMorph({ commitHash: head });
    expect(result.commitHash).toBe(head);
    expect(result.conversationId).toBe("conv-undo");
    expect(result.originThreadKey).toBe("thread-run-undo");
    // The file is gone and the tree is clean (revert commit, not reset).
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/undo.tsx"), "utf8"),
    ).rejects.toThrow();
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);

    // Revert-notice ledger row routes to both the conversation and the
    // originating agent thread.
    const orchestratorPending =
      h.sessionStore.listPendingOrchestratorReverts("conv-undo");
    expect(orchestratorPending).toHaveLength(1);
    expect(orchestratorPending[0]?.commitHash).toBe(head);
    expect(orchestratorPending[0]?.files).toEqual(["desktop/src/undo.tsx"]);
    expect(
      h.sessionStore.listPendingOriginThreadReverts("thread-run-undo"),
    ).toHaveLength(1);

    // The revert itself went through the morph pipeline; drain it.
    const transitions = methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION);
    expect(transitions).toHaveLength(2);
    const revertTransition = (
      transitions[1]!.params as { transitionId: string }
    ).transitionId;
    await h.coordinator.resumeTransition({ transitionId: revertTransition });
    // Every paused run was eventually resumed.
    expect(new Set(resumedRunIds(h))).toEqual(new Set(pausedRunIds(h)));
  });

  it("external lifecycle failure cancels the run without committing", async () => {
    const before = await getGitHead(h.repoRoot);
    await h.coordinator.externalLifecycle.beginExternalSelfMod({
      runId: "ext-1",
      paths: ["desktop/src/ext.tsx"],
    });
    await writeRepoFile(h, "desktop/src/ext.tsx", "export const ext = 1;\n");
    await h.coordinator.externalLifecycle.finishExternalSelfMod({
      runId: "ext-1",
      succeeded: false,
    });
    expect(await getGitHead(h.repoRoot)).toBe(before);
    expect(new Set(resumedRunIds(h))).toEqual(new Set(["ext-1"]));
  });

  it("runs with no tracked writes release their reload pause without a transition", async () => {
    await h.controller.beginRun("run-empty");
    await h.coordinator.lifecycle.beginRun({
      runId: "run-empty",
      taskDescription: "No-op",
      taskPrompt: "prompt",
      conversationId: "conv-empty",
    });
    await h.coordinator.lifecycle.finalizeRun({
      runId: "run-empty",
      taskDescription: "No-op",
      taskPrompt: "prompt",
      conversationId: "conv-empty",
      succeeded: true,
    });
    expect(resumedRunIds(h)).toEqual(["run-empty"]);
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(0);
    expect(h.pendingApplies.size).toBe(0);
  });
});
