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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METHOD_NAMES } from "../../../../runtime/protocol/index.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import { SessionStore } from "../../../../runtime/kernel/storage/session-store.js";
import { SelfModPendingStore } from "../../../../runtime/kernel/storage/self-mod-pending-store.js";
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
  pendingStore: SelfModPendingStore;
  controller: SelfModHmrController;
  coordinator: SelfModCoordinator;
  pendingApplies: Map<string, PendingSelfModApply>;
  requests: RecordedRequest[];
  hostTransitionGate: {
    enabled: boolean;
    release: () => void;
  };
  statusPatches: Array<{
    conversationId: string;
    eventId?: string;
    applyId?: string;
    commitHash?: string;
    status: "pending" | "applied" | "reverted";
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
  const pendingStore = new SelfModPendingStore(db, repoRoot);

  const requests: RecordedRequest[] = [];
  const hostTransitionWaiters: Array<() => void> = [];
  const hostTransitionGate = {
    enabled: false,
    release: () => {
      for (const resolve of hostTransitionWaiters.splice(0)) resolve();
    },
  };
  const peer: WorkerPeerLike = {
    notify: () => {},
    request: async <TResult>(method: string, params?: unknown) => {
      requests.push({ method, params });
      if (
        method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION &&
        hostTransitionGate.enabled
      ) {
        await new Promise<void>((resolve) => {
          hostTransitionWaiters.push(resolve);
        });
      }
      return {} as TResult;
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
    getPendingSelfModStore: () => pendingStore,
    patchSelfModApplyStatus: (args) => {
      statusPatches.push({
        conversationId: args.conversationId,
        ...(args.eventId ? { eventId: args.eventId } : {}),
        ...(args.applyId ? { applyId: args.applyId } : {}),
        ...(args.commitHash ? { commitHash: args.commitHash } : {}),
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
    pendingStore,
    controller,
    coordinator,
    pendingApplies,
    requests,
    hostTransitionGate,
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
    ownerThreadId: "general-1",
    succeeded: true,
  });
};

const publishCompletion = async (
  h: Harness,
  conversationId: string,
  completionEventId: string,
) =>
  await h.coordinator.lifecycle.publishCompletion({
    conversationId,
    ownerThreadId: "general-1",
    completionEventId,
  });

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
    // …and the apply is parked behind the pending card, keyed by the run that
    // wrote it (not by commit — the card must not depend on git).
    expect([...h.pendingApplies.keys()]).toEqual(["run-1"]);
    const pending = h.pendingApplies.get("run-1")!;
    expect(pending.applyId).toBe("run-1");
    expect(pending.commitHash).toBe(head);
    expect(pending.conversationId).toBe("conv-1");
    expect(pending.files).toEqual(["desktop/src/feature.tsx"]);
    // No morph transition was raised and the reload pause is still held.
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(0);
    expect(pausedRunIds(h)).toEqual(["run-1"]);
    expect(resumedRunIds(h)).toEqual([]);
    expect(h.coordinator.hasPendingApplyBatches()).toBe(false);
  });

  it("stages the card from tracked writes even when no commit lands", async () => {
    // Dirty the file BEFORE the run begins so it lands in the run's baseline
    // and `finalizeSelfModRun` commits nothing (returns null). The write is
    // still tracked, which is all the card needs — applying is an HMR swap of
    // content already on disk.
    await writeRepoFile(
      h,
      "desktop/src/preexisting.tsx",
      "export const a = 1;\n",
    );
    const headBefore = await getGitHead(h.repoRoot);

    await h.controller.beginRun("run-nocommit");
    await h.coordinator.lifecycle.beginRun({
      runId: "run-nocommit",
      taskDescription: "Task run-nocommit",
      taskPrompt: "prompt",
      conversationId: "conv-nc",
      mode: "author",
    });
    await writeRepoFile(
      h,
      "desktop/src/preexisting.tsx",
      "export const a = 2;\n",
    );
    await h.controller.recordWrite("run-nocommit", [
      path.join(h.repoRoot, "desktop/src/preexisting.tsx"),
    ]);
    await h.coordinator.lifecycle.finalizeRun({
      runId: "run-nocommit",
      taskDescription: "Task run-nocommit",
      taskPrompt: "prompt",
      conversationId: "conv-nc",
      threadKey: "thread-run-nocommit",
      ownerThreadId: "general-1",
      succeeded: true,
    });

    // Nothing was committed…
    expect(await getGitHead(h.repoRoot)).toBe(headBefore);
    // …yet the card is staged, identified by the run and with no hash, so the
    // UI shows Update but withholds Undo.
    const pending = h.pendingApplies.get("run-nocommit")!;
    expect(pending).toBeDefined();
    expect(pending.applyId).toBe("run-nocommit");
    expect(pending.commitHash).toBeUndefined();
    expect(pending.conversationId).toBe("conv-nc");
    expect(pending.files).toEqual(["desktop/src/preexisting.tsx"]);
    // Still deferred behind the card rather than auto-applied.
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(0);
  });

  it("keeps child finalization unpublished until its owning General completes", async () => {
    await runAgentSelfMod(
      h,
      "run-late",
      "desktop/src/late.tsx",
      "export const late = true;\n",
      "conv-late",
    );

    const pending = h.pendingApplies.get("run-late")!;
    expect(pending.commitHash).toBe(await getGitHead(h.repoRoot));
    expect(pending.changeSetId).toBeUndefined();
    expect(pending.assistantMessageEventId).toBeUndefined();

    const published = await publishCompletion(h, "conv-late", "completion-1");
    expect(published).toEqual({
      changeSetId: "self-mod-change-set:completion-1",
      contributionCount: 1,
    });
    expect(pending.changeSetId).toBe("self-mod-change-set:completion-1");
    expect(pending.completionEventId).toBe("completion-1");
  });

  it("keeps contention-drained child and parent runs as separate owner contributions", async () => {
    for (const runId of ["child-run", "parent-run"]) {
      await h.controller.beginRun(runId);
      await h.coordinator.lifecycle.beginRun({
        runId,
        taskDescription: `Task ${runId}`,
        taskPrompt: "prompt",
        conversationId: "conv-shared",
        mode: "author",
      });
    }

    const sharedPath = "desktop/src/shared.tsx";
    await writeRepoFile(h, sharedPath, "export const owner = 'child';\n");
    await h.controller.recordWrite("child-run", [
      path.join(h.repoRoot, sharedPath),
    ]);
    await writeRepoFile(h, sharedPath, "export const owner = 'parent';\n");
    await h.controller.recordWrite("parent-run", [
      path.join(h.repoRoot, sharedPath),
    ]);

    await h.coordinator.lifecycle.finalizeRun({
      runId: "child-run",
      taskDescription: "Child task",
      taskPrompt: "prompt",
      conversationId: "conv-shared",
      threadKey: "child-thread",
      ownerThreadId: "general-1",
      succeeded: true,
    });
    expect(h.pendingApplies.size).toBe(0);

    await h.coordinator.lifecycle.finalizeRun({
      runId: "parent-run",
      taskDescription: "Parent task",
      taskPrompt: "prompt",
      conversationId: "conv-shared",
      threadKey: "general-1",
      ownerThreadId: "general-1",
      succeeded: true,
    });

    expect([...h.pendingApplies.keys()]).toEqual(["child-run", "parent-run"]);
    expect(
      h.pendingApplies
        .get("child-run")
        ?.applyResult.appliedRuns.map((run) => run.runId),
    ).toEqual(["child-run"]);
    expect(
      h.pendingApplies
        .get("parent-run")
        ?.applyResult.appliedRuns.map((run) => run.runId),
    ).toEqual(["parent-run"]);
    expect(
      await publishCompletion(h, "conv-shared", "completion-shared"),
    ).toEqual({
      changeSetId: "self-mod-change-set:completion-shared",
      contributionCount: 2,
    });
  });

  it("stages a held author contribution when its blocker is canceled", async () => {
    for (const runId of ["held-child", "blocking-parent"]) {
      await h.controller.beginRun(runId);
      await h.coordinator.lifecycle.beginRun({
        runId,
        taskDescription: `Task ${runId}`,
        taskPrompt: "prompt",
        conversationId: "conv-cancel",
        mode: "author",
      });
    }

    const sharedPath = "desktop/src/cancel-shared.tsx";
    await writeRepoFile(h, sharedPath, "export const owner = 'child';\n");
    await h.controller.recordWrite("held-child", [
      path.join(h.repoRoot, sharedPath),
    ]);
    await h.controller.recordWrite("blocking-parent", [
      path.join(h.repoRoot, sharedPath),
    ]);
    await h.coordinator.lifecycle.finalizeRun({
      runId: "held-child",
      taskDescription: "Held child",
      taskPrompt: "prompt",
      conversationId: "conv-cancel",
      ownerThreadId: "general-1",
      succeeded: true,
    });
    expect(h.pendingApplies.size).toBe(0);

    await h.coordinator.lifecycle.cancelRun("blocking-parent");

    expect([...h.pendingApplies.keys()]).toEqual(["held-child"]);
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(0);
    expect(
      await publishCompletion(h, "conv-cancel", "completion-cancel"),
    ).toEqual({
      changeSetId: "self-mod-change-set:completion-cancel",
      contributionCount: 1,
    });
  });

  it("reuses a publish-before-send set when terminal delivery retries", async () => {
    await runAgentSelfMod(
      h,
      "run-first",
      "desktop/src/first.tsx",
      "export const first = true;\n",
      "conv-owner",
    );
    expect(
      await h.coordinator.lifecycle.publishCompletion({
        conversationId: "conv-owner",
        ownerThreadId: "another-general",
        completionEventId: "wrong-owner-completion",
      }),
    ).toEqual({
      changeSetId: "self-mod-change-set:wrong-owner-completion",
      contributionCount: 0,
    });

    const first = await publishCompletion(h, "conv-owner", "completion-1");
    expect(first.contributionCount).toBe(1);
    await runAgentSelfMod(
      h,
      "run-later",
      "desktop/src/later.tsx",
      "export const later = true;\n",
      "conv-owner",
    );

    // The set is published before the hidden orchestrator turn starts. If that
    // delivery fails and the terminal event replays, it must return the same
    // set and cannot pull a contribution finalized afterwards into that card.
    expect(await publishCompletion(h, "conv-owner", "completion-1")).toEqual(
      first,
    );
    expect(h.pendingApplies.get("run-later")?.changeSetId).toBeUndefined();
    expect(await publishCompletion(h, "conv-owner", "completion-2")).toEqual({
      changeSetId: "self-mod-change-set:completion-2",
      contributionCount: 1,
    });
  });

  it("applies an attached change set after the worker cache rehydrates", async () => {
    await runAgentSelfMod(
      h,
      "restart-run",
      "desktop/src/restart.tsx",
      "export const restarted = true;\n",
      "conv-restart",
    );
    const published = await publishCompletion(
      h,
      "conv-restart",
      "completion-restart",
    );
    h.pendingStore.markAttached({
      completionEventId: "completion-restart",
      assistantMessageEventId: "assistant-restart",
    });

    // Mirror worker shutdown/startup: the cache is lost, interrupted claims
    // are recovered, and SQLite repopulates it in finalize order.
    h.pendingApplies.clear();
    h.pendingStore.recoverInterruptedApplies();
    for (const contribution of h.pendingStore.listPendingContributions()) {
      h.pendingApplies.set(contribution.applyId, contribution);
    }
    expect(h.pendingApplies.get("restart-run")).toMatchObject({
      changeSetId: published.changeSetId,
      completionEventId: "completion-restart",
      assistantMessageEventId: "assistant-restart",
    });

    h.hostTransitionGate.enabled = true;
    const applyPromise = h.coordinator.applyPendingWithMorph({
      applyId: published.changeSetId,
    });
    await vi.waitFor(() => {
      expect(
        methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION),
      ).toHaveLength(1);
    });
    // The real host calls resume while the outer transition RPC is still
    // pending. Durable completion must happen inside that callback, before it
    // releases the runtime pause that can trigger a worker restart.
    const transitionId = (
      methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)[0]!.params as {
        transitionId: string;
      }
    ).transitionId;
    expect(
      await h.coordinator.resumeTransition({ transitionId }),
    ).toMatchObject({ ok: true });
    expect(h.pendingStore.listPendingContributions()).toEqual([]);
    expect(h.pendingApplies.size).toBe(0);
    h.hostTransitionGate.release();
    await expect(applyPromise).resolves.toMatchObject({ applied: true });
  });

  it("applies a card that has no commit hash and patches it by applyId", async () => {
    // The user can click Update on a card whose commit never landed: the id on
    // the wire is only used for the lost-stash fallback, so an absent hash must
    // not block the apply.
    await writeRepoFile(h, "desktop/src/nc2.tsx", "export const a = 1;\n");
    await h.controller.beginRun("run-nc2");
    await h.coordinator.lifecycle.beginRun({
      runId: "run-nc2",
      taskDescription: "Task run-nc2",
      taskPrompt: "prompt",
      conversationId: "conv-nc2",
      mode: "author",
    });
    await writeRepoFile(h, "desktop/src/nc2.tsx", "export const a = 2;\n");
    await h.controller.recordWrite("run-nc2", [
      path.join(h.repoRoot, "desktop/src/nc2.tsx"),
    ]);
    await h.coordinator.lifecycle.finalizeRun({
      runId: "run-nc2",
      taskDescription: "Task run-nc2",
      taskPrompt: "prompt",
      conversationId: "conv-nc2",
      threadKey: "thread-run-nc2",
      ownerThreadId: "general-1",
      succeeded: true,
    });
    expect(h.pendingApplies.get("run-nc2")?.commitHash).toBeUndefined();

    const published = await publishCompletion(h, "conv-nc2", "completion-nc2");
    const result = await h.coordinator.applyPendingWithMorph({
      applyId: published.changeSetId,
    });

    expect(result.applied).toBe(true);
    expect(result.commitHash).toBeUndefined();
    // Card drained and flipped to applied, matched by applyId rather than hash.
    expect(h.pendingApplies.size).toBe(0);
    expect(h.statusPatches).toEqual([
      {
        conversationId: "conv-nc2",
        applyId: "self-mod-change-set:completion-nc2",
        status: "applied",
      },
    ]);
    expect(methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)).toHaveLength(1);
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

  it("clicking Update applies only its published change set and leaves later work pending", async () => {
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

    const firstPublication = await publishCompletion(
      h,
      "conv-1",
      "completion-1",
    );
    expect(firstPublication.contributionCount).toBe(2);

    await runAgentSelfMod(
      h,
      "run-3",
      "desktop/src/three.tsx",
      "export const three = 3;\n",
      "conv-1",
    );
    const thirdHead = (await getGitHead(h.repoRoot))!;
    const secondPublication = await publishCompletion(
      h,
      "conv-1",
      "completion-2",
    );
    expect(secondPublication.contributionCount).toBe(1);

    const applyResult = await h.coordinator.applyPendingWithMorph({
      applyId: firstPublication.changeSetId,
    });
    expect(applyResult).toEqual({ commitHash: secondHead, applied: true });
    // Only the two contributions published by completion-1 drain into one
    // transition. The later completion-2 contribution remains untouched.
    const transitions = methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION);
    expect(transitions).toHaveLength(1);
    expect([...h.pendingApplies.keys()]).toEqual(["run-3"]);
    expect(h.pendingApplies.get("run-3")?.commitHash).toBe(thirdHead);
    expect(h.statusPatches).toEqual([
      {
        conversationId: "conv-1",
        applyId: "self-mod-change-set:completion-1",
        status: "applied",
      },
    ]);
    expect(h.coordinator.hasPendingApplyBatches()).toBe(true);

    // Host raised the cover and calls back; the worker applies + releases.
    const transitionId = (transitions[0]!.params as { transitionId: string })
      .transitionId;
    const resume = await h.coordinator.resumeTransition({ transitionId });
    expect(resume).toEqual({ ok: true, requiresClientFullReload: false });
    expect(h.coordinator.hasPendingApplyBatches()).toBe(false);
    expect(new Set(resumedRunIds(h))).toEqual(new Set(["run-1", "run-2"]));
    expect(resumedRunIds(h)).not.toContain("run-3");
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
    const publication = await publishCompletion(
      h,
      "conv-undo",
      "completion-undo",
    );
    await h.coordinator.applyPendingWithMorph({
      applyId: publication.changeSetId,
    });
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

  it("undoes a published contribution set atomically and preserves per-thread notices", async () => {
    await runAgentSelfMod(
      h,
      "run-group-a",
      "desktop/src/group-a.tsx",
      "export const groupA = 1;\n",
      "conv-group",
    );
    const firstCommit = (await getGitHead(h.repoRoot))!;
    await runAgentSelfMod(
      h,
      "run-group-b",
      "desktop/src/group-b.tsx",
      "export const groupB = 1;\n",
      "conv-group",
    );
    const secondCommit = (await getGitHead(h.repoRoot))!;

    const publication = await publishCompletion(
      h,
      "conv-group",
      "completion-group",
    );
    h.pendingStore.markAttached({
      completionEventId: "completion-group",
      assistantMessageEventId: "assistant-group",
    });
    await h.coordinator.applyPendingWithMorph({
      applyId: publication.changeSetId,
    });
    const adoptTransition = (
      methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)[0]!.params as {
        transitionId: string;
      }
    ).transitionId;
    await h.coordinator.resumeTransition({ transitionId: adoptTransition });

    const result = await h.coordinator.revertWithMorph({
      applyId: publication.changeSetId,
      // Deliberately shuffled. Only the kernel owns chronology and reversal.
      commitHashes: [secondCommit, firstCommit],
    });

    expect(result.commitHashes).toEqual([firstCommit, secondCommit]);
    expect(result.revertedCommitHashes).toEqual([secondCommit, firstCommit]);
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/group-a.tsx"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/group-b.tsx"), "utf8"),
    ).rejects.toThrow();
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);

    expect(
      new Set(
        h.sessionStore
          .listPendingOrchestratorReverts("conv-group")
          .map((entry) => entry.commitHash),
      ),
    ).toEqual(new Set([firstCommit, secondCommit]));
    expect(
      h.sessionStore.listPendingOriginThreadReverts("thread-run-group-a"),
    ).toHaveLength(1);
    expect(
      h.sessionStore.listPendingOriginThreadReverts("thread-run-group-b"),
    ).toHaveLength(1);
    expect(h.statusPatches.at(-1)).toMatchObject({
      conversationId: "conv-group",
      eventId: "assistant-group",
      applyId: publication.changeSetId,
      status: "reverted",
    });

    const transitions = methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION);
    expect(transitions).toHaveLength(2);
    const revertTransition = (
      transitions[1]!.params as { transitionId: string }
    ).transitionId;
    await h.coordinator.resumeTransition({ transitionId: revertTransition });
    expect(new Set(resumedRunIds(h))).toEqual(new Set(pausedRunIds(h)));
  });

  it("rejects a partial grouped request before touching Git", async () => {
    await runAgentSelfMod(
      h,
      "run-bound-a",
      "desktop/src/bound-a.tsx",
      "export const boundA = 1;\n",
      "conv-bound",
    );
    const firstCommit = (await getGitHead(h.repoRoot))!;
    await runAgentSelfMod(
      h,
      "run-bound-b",
      "desktop/src/bound-b.tsx",
      "export const boundB = 1;\n",
      "conv-bound",
    );
    const headBefore = (await getGitHead(h.repoRoot))!;
    const publication = await publishCompletion(
      h,
      "conv-bound",
      "completion-bound",
    );

    await expect(
      h.coordinator.revertWithMorph({
        applyId: publication.changeSetId,
        commitHashes: [firstCommit],
      }),
    ).rejects.toThrow(/durable commit set/);

    expect(await getGitHead(h.repoRoot)).toBe(headBefore);
    expect(await readFile(path.join(h.repoRoot, "desktop/src/bound-a.tsx"), "utf8"))
      .toBe("export const boundA = 1;\n");
    expect(await readFile(path.join(h.repoRoot, "desktop/src/bound-b.tsx"), "utf8"))
      .toBe("export const boundB = 1;\n");
  });

  it("cancels synthetic HMR ownership when grouped Undo fails", async () => {
    await runAgentSelfMod(
      h,
      "run-failed-undo",
      "desktop/src/failed-undo.tsx",
      "export const failedUndo = 1;\n",
      "conv-failed-undo",
    );
    const commitHash = (await getGitHead(h.repoRoot))!;
    const publication = await publishCompletion(
      h,
      "conv-failed-undo",
      "completion-failed-undo",
    );
    await h.coordinator.applyPendingWithMorph({
      applyId: publication.changeSetId,
    });
    const adoptTransition = (
      methodsOf(h, METHOD_NAMES.HOST_HMR_RUN_TRANSITION)[0]!.params as {
        transitionId: string;
      }
    ).transitionId;
    await h.coordinator.resumeTransition({ transitionId: adoptTransition });
    await writeRepoFile(
      h,
      "desktop/src/user-wip.tsx",
      "export const userWip = 1;\n",
    );

    await expect(
      h.coordinator.revertWithMorph({
        applyId: publication.changeSetId,
        commitHashes: [commitHash],
      }),
    ).rejects.toThrow(/working tree is not clean/);

    const syntheticRunId = pausedRunIds(h).at(-1)!;
    expect(syntheticRunId).toMatch(/^self-mod-revert:/);
    expect(h.controller.hasRun(syntheticRunId)).toBe(false);
    expect(resumedRunIds(h)).toContain(syntheticRunId);
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/user-wip.tsx"), "utf8"),
    ).toBe("export const userWip = 1;\n");
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
