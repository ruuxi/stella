import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";

import { selfModHmrControl } from "../../../vite/self-mod-hmr-plugin.js";
import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";
import { createAgentOrchestration } from "../../../../runtime/kernel/runner/agent-orchestration.js";
import { launchPreparedOrchestratorRun } from "../../../../runtime/kernel/runner/orchestrator-launch.js";
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
import { METHOD_NAMES } from "../../../../runtime/protocol/index.js";
import { getSelfModMutationLockStatus } from "../../../../runtime/kernel/self-mod/mutation-lock.js";
import { handleApplyPatch } from "../../../../runtime/kernel/tools/apply-patch.js";
import type {
  ToolContext,
  ToolResult,
} from "../../../../runtime/kernel/tools/types.js";

type HarnessDriver = {
  runTool: (
    surface: "subagent" | "orchestrator",
    executor: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
    ) => Promise<ToolResult>,
  ) => Promise<ToolResult>;
};

const getDriver = (): HarnessDriver =>
  (globalThis as unknown as { __selfModProductionHarness: HarnessDriver })
    .__selfModProductionHarness;

vi.mock("../../../../runtime/kernel/model-routing.js", () => ({
  resolveLlmRoute: vi.fn(() => ({
    model: { id: "test-model", provider: "test-provider" },
    route: "direct-provider",
    getApiKey: () => "test-key",
  })),
}));

vi.mock("../../../../runtime/kernel/agent-runtime.js", () => ({
  shutdownSubagentRuntimes: vi.fn(),
  runSubagentTask: vi.fn(
    async (opts: {
      toolExecutor: HarnessDriver["runTool"] extends (
        surface: never,
        executor: infer T,
      ) => unknown
        ? T
        : never;
      suppressCompletionSideEffects?: boolean;
    }) => {
      // The commit-subject / feature namer runs a no-tools one-shot
      // (`suppressCompletionSideEffects`) that must never mutate the working
      // tree. Short-circuit it so it does not re-enter the harness driver.
      if (opts.suppressCompletionSideEffects) {
        return { runId: "one-shot-run", result: "named", error: undefined };
      }
      const result = await getDriver().runTool("subagent", opts.toolExecutor);
      return {
        runId: "subagent-run",
        result: result.error ? "" : "done",
        error: result.error,
        fileChanges: result.fileChanges,
        producedFiles: result.producedFiles,
      };
    },
  ),
  runOrchestratorTurn: vi.fn(
    async (opts: {
      toolExecutor: HarnessDriver["runTool"] extends (
        surface: never,
        executor: infer T,
      ) => unknown
        ? T
        : never;
      beforeRunEnd?: () => Promise<void>;
      callbacks: { onEnd?: (event: Record<string, unknown>) => void };
      runId: string;
      agentType: string;
    }) => {
      const result = await getDriver().runTool(
        "orchestrator",
        opts.toolExecutor,
      );
      await opts.beforeRunEnd?.();
      opts.callbacks.onEnd?.({
        type: "run_finished",
        runId: opts.runId,
        agentType: opts.agentType,
        seq: 1,
        finalText: result.error ? "" : "done",
        timestamp: Date.now(),
      });
    },
  ),
}));

const roots: string[] = [];
const servers: ViteDevServer[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  delete (
    globalThis as unknown as { __selfModProductionHarness?: HarnessDriver }
  ).__selfModProductionHarness;
  for (const server of servers.splice(0)) await server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
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

const createRepo = async () => {
  const repoRoot = await mkdtemp(
    path.join(os.tmpdir(), "stella-prod-harness-"),
  );
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "stella-prod-harness-db-"),
  );
  roots.push(repoRoot, dataRoot);
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "desktop/src"), { recursive: true });
  await writeFile(path.join(repoRoot, ".gitignore"), ".vite/\nnode_modules/\n");
  await writeFile(path.join(repoRoot, "index.html"), "<div id='app'></div>\n");
  await writeFile(
    path.join(repoRoot, "desktop/src/shared.ts"),
    "export const value = 'original';\n",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "seed"]);

  const database = new DatabaseSync(getDesktopDatabasePath(dataRoot), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  databases.push(database);
  initializeDesktopDatabase(database);
  const service = new StoreModService(repoRoot, new StoreModStore(database));
  const applyPayloads: unknown[] = [];
  const overlayServedReads: Array<{
    path: string;
    status: number;
    content: string;
  }> = [];
  const overlayReadyPaths: string[][] = [];

  const previousMode = process.env.STELLA_SELF_MOD_HMR_MODE;
  process.env.STELLA_SELF_MOD_HMR_MODE = "live";
  const port = await reservePort();
  let devServerUrl = "";
  const server = await createServer({
    root: repoRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: [
      selfModHmrControl({
        repoRoot,
        onOverlayReady: async (paths) => {
          overlayReadyPaths.push(paths);
          for (const repoRelativePath of paths) {
            const response = await fetch(
              `${devServerUrl}${repoRelativePath}?selfmod-overlay-probe=${overlayServedReads.length}`,
              { headers: { Origin: new URL(devServerUrl).origin } },
            );
            overlayServedReads.push({
              path: repoRelativePath,
              status: response.status,
              content: await response.text(),
            });
          }
        },
      }),
    ],
  });
  if (previousMode === undefined) delete process.env.STELLA_SELF_MOD_HMR_MODE;
  else process.env.STELLA_SELF_MOD_HMR_MODE = previousMode;
  servers.push(server);
  await server.listen();
  devServerUrl = server.resolvedUrls?.local[0] ?? "";
  if (!devServerUrl) throw new Error("Vite harness did not resolve a URL.");
  const controller = createSelfModHmrController({
    enabled: true,
    getDevServerUrl: () => devServerUrl,
    repoRoot,
    observeApplyPayload: (payload) => applyPayloads.push(payload),
  });
  const pending = new Map<string, PendingSelfModApply>();
  const hostRequests: Array<{ method: string; params: unknown }> = [];
  const statusPatches: Array<Record<string, unknown>> = [];
  const peer = {
    notify: () => {},
    request: async <TResult>(method: string, params?: unknown) => {
      hostRequests.push({ method, params });
      return {} as TResult;
    },
    registerRequestHandler: () => {},
    registerNotificationHandler: () => {},
  } as any;
  const coordinator = createSelfModCoordinator({
    peer,
    getController: () => controller,
    getStoreModService: () => service,
    getRuntimeStore: () => null,
    getRepoRoot: () => repoRoot,
    getPendingSelfModApplies: () => pending,
    patchSelfModApplyStatus: (args) => statusPatches.push(args),
  });
  return {
    repoRoot,
    dataRoot,
    service,
    controller,
    coordinator,
    pending,
    hostRequests,
    statusPatches,
    devServerUrl,
    applyPayloads,
    overlayServedReads,
    overlayReadyPaths,
    database,
  };
};

const waitForAgent = async (
  manager: { getAgent: (id: string) => Promise<{ status?: string } | null> },
  threadId: string,
) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await manager.getAgent(threadId);
    if (["completed", "error", "canceled"].includes(snapshot?.status ?? "")) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for subagent.");
};

const patchFor = (filePath: string, from: string, to: string): string =>
  [
    "*** Begin Patch",
    `*** Update File: ${filePath}`,
    "@@",
    `-export const value = '${from}';`,
    `+export const value = '${to}';`,
    "*** End Patch",
    "",
  ].join("\n");

type ProductionHarness = Awaited<ReturnType<typeof createRepo>>;

const beginAuthorRun = async (h: ProductionHarness, runId: string) => {
  await h.controller.beginRun(runId);
  await h.coordinator.lifecycle.beginRun({
    runId,
    taskDescription: `synthetic ${runId}`,
    taskPrompt: `synthetic ${runId}`,
    conversationId: `conversation-${runId}`,
    mode: "author",
  });
};

const writeAuthorText = async (
  h: ProductionHarness,
  runId: string,
  relativePath: string,
  content: string,
) => {
  const absolutePath = path.join(h.repoRoot, relativePath);
  const capture = await h.coordinator.lifecycle.beginMediatedWrite({
    runId,
    paths: [absolutePath],
  });
  await h.controller.recordWrite(runId, [absolutePath], {
    captureSnapshot: false,
  });
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  await h.coordinator.lifecycle.finishMediatedWrite({ capture });
  await h.controller.recordWrite(runId, [absolutePath]);
};

const finalizeAuthorRun = async (
  h: ProductionHarness,
  runId: string,
): Promise<string> => {
  await h.coordinator.lifecycle.finalizeRun({
    runId,
    taskDescription: `synthetic ${runId}`,
    taskPrompt: `synthetic ${runId}`,
    conversationId: `conversation-${runId}`,
    succeeded: true,
  });
  const selector = [...h.pending.values()].find(
    (pending) => pending.runId === runId,
  )?.changeSetId;
  if (!selector) throw new Error(`Missing selector for ${runId}`);
  return selector;
};

const resumeLatestTransition = async (h: ProductionHarness) => {
  const transition = [...h.hostRequests]
    .reverse()
    .find((request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION);
  if (!transition) throw new Error("Missing host HMR transition");
  return await h.coordinator.resumeTransition({
    transitionId: (transition.params as { transitionId: string }).transitionId,
  });
};

const runIndependentWrapperAttribution = async (
  order:
    | readonly ["subagent", "orchestrator"]
    | readonly ["orchestrator", "subagent"],
) => {
  const h = await createRepo();
  const relativePath = "desktop/src/shared.ts";
  const filePath = path.join(h.repoRoot, relativePath);
  const original =
    "export const value = 'original';\nexport const second = 'original';\n";
  const combined =
    "export const value = 'from-subagent';\nexport const second = 'from-orchestrator';\n";
  await writeFile(filePath, original);
  git(h.repoRoot, ["add", relativePath]);
  git(h.repoRoot, ["commit", "-q", "-m", "seed independent lines"]);
  const seedHead = git(h.repoRoot, ["rev-parse", "HEAD"]).trim();

  let firstEnteredResolve!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    firstEnteredResolve = resolve;
  });
  let secondEnteredResolve!: () => void;
  const secondEntered = new Promise<void>((resolve) => {
    secondEnteredResolve = resolve;
  });
  let firstWrittenResolve!: () => void;
  const firstWritten = new Promise<void>((resolve) => {
    firstWrittenResolve = resolve;
  });
  let toolEntries = 0;
  const toolHost = {
    getToolCatalog: () => [],
    executeTool: async (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
    ) => {
      if (toolName !== "apply_patch") return { result: "unused" };
      toolEntries += 1;
      if (toolEntries === 1) {
        firstEnteredResolve();
        await Promise.race([
          secondEntered,
          new Promise((resolve) => setTimeout(resolve, 150)),
        ]);
        const result = await handleApplyPatch(args, context);
        firstWrittenResolve();
        return result;
      }
      secondEnteredResolve();
      await firstWritten;
      return await handleApplyPatch(args, context);
    },
    registerExtensionTools: vi.fn(),
    drainCompletedShellProducedFiles: vi.fn(async () => []),
    killAllShells: vi.fn(),
    killShell: vi.fn(),
    killShellsByPort: vi.fn(),
    shutdown: vi.fn(),
  };
  let nextThread = 0;
  const context = {
    stellaAppDir: h.repoRoot,
    stellaDataDir: h.dataRoot,
    deviceId: "device-1",
    runtimeStore: {
      resolveOrCreateActiveThread: () => ({
        threadId: `thread-${++nextThread}`,
        reused: false,
      }),
      listActiveThreads: () => [],
      saveAgentRecord: vi.fn(),
      getAgentRecord: () => null,
    },
    appendLocalChatEvent: vi.fn(),
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map(),
      conversationCallbacks: new Map(),
      convexSiteUrl: null,
      authToken: null,
      orchestratorSessions: new Map(),
    },
    selfModHmrController: h.controller,
    selfModLifecycle: h.coordinator.lifecycle,
    toolHost,
    hookEmitter: { emit: vi.fn() },
    paths: {},
  } as any;
  (
    globalThis as unknown as { __selfModProductionHarness: HarnessDriver }
  ).__selfModProductionHarness = {
    runTool: async (surface, executor) =>
      await executor(
        "apply_patch",
        {
          input:
            surface === "subagent"
              ? [
                  "*** Begin Patch",
                  `*** Update File: ${filePath}`,
                  "@@",
                  "-export const value = 'original';",
                  "+export const value = 'from-subagent';",
                  "*** End Patch",
                  "",
                ].join("\n")
              : [
                  "*** Begin Patch",
                  `*** Update File: ${filePath}`,
                  "@@",
                  "-export const second = 'original';",
                  "+export const second = 'from-orchestrator';",
                  "*** End Patch",
                  "",
                ].join("\n"),
        },
        {
          conversationId: `${surface}-conversation`,
          deviceId: "device-1",
          requestId: `${surface}-request`,
          stellaAppDir: h.repoRoot,
        },
      ),
  };

  createAgentOrchestration(context, {
    buildAgentContext: async () => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 1,
    }),
    sendMessage: async () => {},
  });
  const { threadId } = await context.state.localAgentManager.createAgent({
    conversationId: "subagent-conversation",
    description: "subagent-independent",
    prompt: "subagent-independent",
    agentType: AGENT_IDS.GENERAL,
    storageMode: "local",
  });
  await firstEntered;
  let orchestratorDoneResolve!: () => void;
  const orchestratorDone = new Promise<void>((resolve) => {
    orchestratorDoneResolve = resolve;
  });
  launchPreparedOrchestratorRun({
    context,
    prepared: {
      runId: "orchestrator-independent",
      conversationId: "orchestrator-conversation",
      agentType: AGENT_IDS.INSTALL_UPDATE,
      userPrompt: "orchestrator-independent",
      attachments: [],
      agentContext: { systemPrompt: "", dynamicContext: "", maxAgentDepth: 1 },
      resolvedLlm: {
        model: { id: "test-model", provider: "test-provider" },
        route: "direct-provider",
        getApiKey: () => "test-key",
      },
      abortController: new AbortController(),
      selfModMetadata: { mode: "author" },
    },
    userMessageId: "orchestrator-user-message",
    runtimeCallbacks: { onEnd: () => orchestratorDoneResolve() },
    cleanupRun: () => {},
    onFatalError: (error) => {
      throw error;
    },
  } as any);
  await Promise.all([
    waitForAgent(context.state.localAgentManager, threadId),
    orchestratorDone,
  ]);

  const selectors = {
    subagent: [...h.pending.values()].find(
      (pending) => pending.conversationId === "subagent-conversation",
    )!.changeSetId,
    orchestrator: [...h.pending.values()].find(
      (pending) => pending.conversationId === "orchestrator-conversation",
    )!.changeSetId,
  };
  const subagentFrozen = h.service.getPreparedLogicalChangeSet(
    selectors.subagent,
  );
  const orchestratorFrozen = h.service.getPreparedLogicalChangeSet(
    selectors.orchestrator,
  );
  expect(subagentFrozen?.files[0]).toMatchObject({
    base: expect.objectContaining({ text: original }),
    incoming: expect.objectContaining({
      text: "export const value = 'from-subagent';\nexport const second = 'original';\n",
    }),
  });
  expect(orchestratorFrozen?.files[0]).toMatchObject({
    base: expect.objectContaining({
      text: "export const value = 'from-subagent';\nexport const second = 'original';\n",
    }),
    incoming: expect.objectContaining({ text: combined }),
  });
  expect(await readFile(filePath, "utf8")).toBe(combined);

  for (const [index, owner] of order.entries()) {
    expect(
      await h.coordinator.applyPendingWithMorph({
        commitHash: selectors[owner],
      }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });
    const expectedHead =
      index === 1
        ? combined
        : owner === "subagent"
          ? "export const value = 'from-subagent';\nexport const second = 'original';\n"
          : "export const value = 'original';\nexport const second = 'from-orchestrator';\n";
    expect(git(h.repoRoot, ["show", `HEAD:${relativePath}`])).toBe(
      expectedHead,
    );
    expect(await readFile(filePath, "utf8")).toBe(combined);
    const overlayContent = h.overlayServedReads.at(-1)?.content ?? "";
    expect(overlayContent).toContain(
      index === 1 || owner === "subagent" ? "from-subagent" : "original",
    );
    expect(overlayContent).toContain(
      index === 1 || owner === "orchestrator"
        ? "from-orchestrator"
        : "original",
    );
    if (index === 0) {
      expect(overlayContent).not.toContain(
        owner === "subagent" ? "from-orchestrator" : "from-subagent",
      );
    }
    expect(git(h.repoRoot, ["diff", "--cached", "--name-only"])).toBe("");
  }
  expect(
    git(h.repoRoot, ["rev-list", "--count", `${seedHead}..HEAD`]).trim(),
  ).toBe("2");
  expect(h.applyPayloads).toHaveLength(2);
  expect(
    h.applyPayloads.every(
      (payload) =>
        (payload as { runs: Array<{ protocolVersion: number }> }).runs[0]
          ?.protocolVersion === 2,
    ),
  ).toBe(true);
};

// Two GENERAL subagent runs pinned to the Codex external engine. External
// engines run under danger-full-access and mutate the shared working tree
// DIRECTLY (outside Stella's mediated-write tool path), so the whole turn must
// be wrapped in one self-mod mutation lease + all-repo capture. Without that,
// two concurrent external turns interleave their raw writes with no per-run
// attribution, and applying one run clobbers the other. This drives the real
// subagent orchestration wrapper; the external turn is simulated by mutating
// disk directly and reporting fileChanges (never calling the tool executor).
const runNativeExternalEngineRace = async (
  order: readonly ["a", "b"] | readonly ["b", "a"],
) => {
  const h = await createRepo();
  const relativePath = "desktop/src/shared.ts";
  const filePath = path.join(h.repoRoot, relativePath);
  const original =
    "export const value = 'original';\nexport const second = 'original';\n";
  const afterA =
    "export const value = 'from-a';\nexport const second = 'original';\n";
  const afterBOnly =
    "export const value = 'original';\nexport const second = 'from-b';\n";
  const combined =
    "export const value = 'from-a';\nexport const second = 'from-b';\n";
  await writeFile(filePath, original);
  git(h.repoRoot, ["add", relativePath]);
  git(h.repoRoot, ["commit", "-q", "-m", "seed external race"]);
  const seedHead = git(h.repoRoot, ["rev-parse", "HEAD"]).trim();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  let aEnteredResolve!: () => void;
  const aEntered = new Promise<void>((resolve) => {
    aEnteredResolve = resolve;
  });
  let lockStatusDuringA: { locked: boolean; queued: number } = {
    locked: false,
    queued: 0,
  };

  let invocation = 0;
  const mutate = async (from: string, to: string) => {
    const current = await readFile(filePath, "utf8");
    await writeFile(filePath, current.replace(from, to));
  };
  const toolHost = {
    getToolCatalog: () => [],
    executeTool: async () => ({ result: "unused" }),
    registerExtensionTools: vi.fn(),
    drainCompletedShellProducedFiles: vi.fn(async () => []),
    killAllShells: vi.fn(),
    killShell: vi.fn(),
    killShellsByPort: vi.fn(),
    shutdown: vi.fn(),
  };
  let nextThread = 0;
  const context = {
    stellaAppDir: h.repoRoot,
    stellaDataDir: h.dataRoot,
    deviceId: "device-1",
    runtimeStore: {
      resolveOrCreateActiveThread: () => ({
        threadId: `thread-${++nextThread}`,
        reused: false,
      }),
      listActiveThreads: () => [],
      saveAgentRecord: vi.fn(),
      getAgentRecord: () => null,
    },
    appendLocalChatEvent: vi.fn(),
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map(),
      conversationCallbacks: new Map(),
      convexSiteUrl: null,
      authToken: null,
      orchestratorSessions: new Map(),
    },
    selfModHmrController: h.controller,
    selfModLifecycle: h.coordinator.lifecycle,
    toolHost,
    hookEmitter: { emit: vi.fn() },
    paths: {},
  } as any;

  (
    globalThis as unknown as { __selfModProductionHarness: HarnessDriver }
  ).__selfModProductionHarness = {
    // The tool executor is intentionally ignored: an external engine mutates
    // the working tree itself and only reports the resulting fileChanges.
    runTool: async (): Promise<ToolResult> => {
      const index = ++invocation;
      if (index === 1) {
        aEnteredResolve();
        // Wait until run B has queued behind the shared mutation lock — proof
        // that the two external turns are serialized rather than interleaved.
        for (
          let attempt = 0;
          attempt < 200 && getSelfModMutationLockStatus(h.repoRoot).queued < 1;
          attempt += 1
        ) {
          await sleep(5);
        }
        lockStatusDuringA = getSelfModMutationLockStatus(h.repoRoot);
        await mutate(
          "export const value = 'original';",
          "export const value = 'from-a';",
        );
        return {
          fileChanges: [{ path: filePath, kind: { type: "update" } }],
        } as ToolResult;
      }
      await mutate(
        "export const second = 'original';",
        "export const second = 'from-b';",
      );
      return {
        fileChanges: [{ path: filePath, kind: { type: "update" } }],
      } as ToolResult;
    },
  };

  createAgentOrchestration(context, {
    buildAgentContext: async () => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 1,
      agentEngine: "codex_cli",
    }),
    sendMessage: async () => {},
  });

  const runA = await context.state.localAgentManager.createAgent({
    conversationId: "run-a",
    description: "external-a",
    prompt: "external-a",
    agentType: AGENT_IDS.GENERAL,
    storageMode: "local",
  });
  // A now holds the lease and is parked inside its turn waiting for B.
  await aEntered;
  const runB = await context.state.localAgentManager.createAgent({
    conversationId: "run-b",
    description: "external-b",
    prompt: "external-b",
    agentType: AGENT_IDS.GENERAL,
    storageMode: "local",
  });
  await Promise.all([
    waitForAgent(context.state.localAgentManager, runA.threadId),
    waitForAgent(context.state.localAgentManager, runB.threadId),
  ]);

  // Run B was blocked on the mutation lock while A's external turn held it.
  expect(lockStatusDuringA.locked).toBe(true);
  expect(lockStatusDuringA.queued).toBeGreaterThanOrEqual(1);

  const selectors = {
    a: [...h.pending.values()].find(
      (pending) => pending.conversationId === "run-a",
    )?.changeSetId,
    b: [...h.pending.values()].find(
      (pending) => pending.conversationId === "run-b",
    )?.changeSetId,
  };
  expect(selectors.a).toBeTruthy();
  expect(selectors.b).toBeTruthy();

  const aFrozen = h.service.getPreparedLogicalChangeSet(selectors.a!);
  const bFrozen = h.service.getPreparedLogicalChangeSet(selectors.b!);
  // Each external turn's changeset holds EXACTLY its own authored delta.
  expect(aFrozen?.files).toHaveLength(1);
  expect(aFrozen?.files[0]).toMatchObject({
    path: relativePath,
    base: expect.objectContaining({ text: original }),
    incoming: expect.objectContaining({ text: afterA }),
  });
  expect(bFrozen?.files).toHaveLength(1);
  expect(bFrozen?.files[0]).toMatchObject({
    path: relativePath,
    base: expect.objectContaining({ text: afterA }),
    incoming: expect.objectContaining({ text: combined }),
  });
  // Runs were genuinely concurrent (both registered before either finalized).
  expect(aFrozen?.concurrentRunIds ?? []).toContain(bFrozen?.runId);
  expect(bFrozen?.concurrentRunIds ?? []).toContain(aFrozen?.runId);
  // The shared working tree holds both edits, neither clobbered.
  expect(await readFile(filePath, "utf8")).toBe(combined);

  // Applying each run in either order materializes only that run's delta.
  for (const [index, owner] of order.entries()) {
    expect(
      await h.coordinator.applyPendingWithMorph({
        commitHash: selectors[owner]!,
      }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });
    const expectedHead =
      index === 1 ? combined : owner === "a" ? afterA : afterBOnly;
    expect(git(h.repoRoot, ["show", `HEAD:${relativePath}`])).toBe(
      expectedHead,
    );
    expect(git(h.repoRoot, ["diff", "--cached", "--name-only"])).toBe("");
  }
  expect(await readFile(filePath, "utf8")).toBe(combined);
  expect(
    git(h.repoRoot, ["rev-list", "--count", `${seedHead}..HEAD`]).trim(),
  ).toBe("2");
};

type ExternalTurnExecutor = Parameters<HarnessDriver["runTool"]>[1];

const selectorForConversation = (
  h: ProductionHarness,
  conversationId: string,
): string | undefined =>
  [...h.pending.values()].find(
    (pending) => pending.conversationId === conversationId,
  )?.changeSetId;

// Drives ONE real external-engine subagent turn through the production
// orchestration wrapper (real mutation lock, all-repo capture, lease reuse,
// git-status discovery, and release). The external engine itself is scripted:
// `driver` mutates the working tree the way Codex/Claude would under
// danger-full-access and returns the fileChanges the engine WOULD report
// (Claude omits Bash-side writes). `executeTool` backs any nested Stella tool
// the driver routes through the passed executor; `selfModLifecycle` can be
// overridden to inject a capture-finalization failure.
const runSingleExternalTurn = async (
  h: ProductionHarness,
  args: {
    conversationId: string;
    agentEngine?: "codex_cli" | "claude_code_local";
    driver: (executor: ExternalTurnExecutor) => Promise<ToolResult>;
    selfModLifecycle?: unknown;
    executeTool?: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      ctx: ToolContext,
    ) => Promise<ToolResult>;
  },
): Promise<{ threadId: string; status: string | undefined }> => {
  let nextThread = 0;
  const toolHost = {
    getToolCatalog: () => [],
    executeTool:
      args.executeTool ?? (async () => ({ result: "unused" }) as ToolResult),
    registerExtensionTools: vi.fn(),
    drainCompletedShellProducedFiles: vi.fn(async () => []),
    killAllShells: vi.fn(),
    killShell: vi.fn(),
    killShellsByPort: vi.fn(),
    shutdown: vi.fn(),
  };
  const context = {
    stellaAppDir: h.repoRoot,
    stellaDataDir: h.dataRoot,
    deviceId: "device-1",
    runtimeStore: {
      resolveOrCreateActiveThread: () => ({
        threadId: `thread-${++nextThread}`,
        reused: false,
      }),
      listActiveThreads: () => [],
      saveAgentRecord: vi.fn(),
      getAgentRecord: () => null,
    },
    appendLocalChatEvent: vi.fn(),
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map(),
      conversationCallbacks: new Map(),
      convexSiteUrl: null,
      authToken: null,
      orchestratorSessions: new Map(),
    },
    selfModHmrController: h.controller,
    selfModLifecycle: args.selfModLifecycle ?? h.coordinator.lifecycle,
    toolHost,
    hookEmitter: { emit: vi.fn() },
    paths: {},
  } as any;

  (
    globalThis as unknown as { __selfModProductionHarness: HarnessDriver }
  ).__selfModProductionHarness = {
    runTool: async (_surface, executor) => await args.driver(executor),
  };

  createAgentOrchestration(context, {
    buildAgentContext: async () => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 1,
      agentEngine: args.agentEngine ?? "codex_cli",
    }),
    sendMessage: async () => {},
  });

  const run = await context.state.localAgentManager.createAgent({
    conversationId: args.conversationId,
    description: args.conversationId,
    prompt: args.conversationId,
    agentType: AGENT_IDS.GENERAL,
    storageMode: "local",
  });
  const snapshot = await waitForAgent(
    context.state.localAgentManager,
    run.threadId,
  );
  return { threadId: run.threadId, status: snapshot?.status };
};

describe("production-path self-mod concurrency harness", () => {
  it("P0: serializes one subagent apply_patch transaction against an orchestrator mutation", async () => {
    const h = await createRepo();
    const filePath = path.join(h.repoRoot, "desktop/src/shared.ts");
    await writeFile(
      filePath,
      "export const value = 'original';\nexport const second = 'original';\n",
    );
    git(h.repoRoot, ["add", "desktop/src/shared.ts"]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed independent attribution"]);
    const finalized = new Map<string, string>();
    let nextThread = 0;
    let firstEnteredResolve!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });
    let secondEnteredResolve!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
      secondEnteredResolve = resolve;
    });
    let xWrittenResolve!: () => void;
    const xWritten = new Promise<void>((resolve) => {
      xWrittenResolve = resolve;
    });
    let yWrittenResolve!: () => void;
    const yWritten = new Promise<void>((resolve) => {
      yWrittenResolve = resolve;
    });
    let toolEntries = 0;

    const toolHost = {
      getToolCatalog: () => [],
      executeTool: async (
        toolName: string,
        args: Record<string, unknown>,
        context: ToolContext,
      ) => {
        if (toolName !== "apply_patch") return { result: "unused" };
        toolEntries += 1;
        const entry = toolEntries;
        if (entry === 1) firstEnteredResolve();
        if (entry === 2) secondEnteredResolve();
        if (entry === 1) {
          await Promise.race([
            secondEntered,
            new Promise((resolve) => setTimeout(resolve, 150)),
          ]);
          const result = await handleApplyPatch(args, context);
          xWrittenResolve();
          if (toolEntries >= 2) await yWritten;
          return result;
        }
        await xWritten;
        const result = await handleApplyPatch(args, context);
        yWrittenResolve();
        return result;
      },
      registerExtensionTools: vi.fn(),
      drainCompletedShellProducedFiles: vi.fn(async () => []),
      killAllShells: vi.fn(),
      killShell: vi.fn(),
      killShellsByPort: vi.fn(),
      shutdown: vi.fn(),
    };

    const lifecycle = {
      beginRun: async (args: {
        runId: string;
        mode?: string;
        taskDescription: string;
      }) => {
        await h.service.beginSelfModRun({
          runId: args.runId,
          taskDescription: args.taskDescription,
          applyMode: "author",
        });
      },
      beginMediatedWrite: async (args: {
        runId: string;
        paths: string[];
        captureAll?: boolean;
      }) =>
        await h.service.beginMediatedWrite(args.runId, args.paths, {
          captureAll: args.captureAll,
        }),
      finishMediatedWrite: async (args: {
        capture: Parameters<StoreModService["finishMediatedWrite"]>[0];
        additionalPaths?: string[];
      }) =>
        await h.service.finishMediatedWrite(args.capture, args.additionalPaths),
      finalizeRun: async (args: {
        runId: string;
        succeeded: boolean;
        conversationId?: string;
      }) => {
        const result = await h.service.finalizeSelfModRun({
          runId: args.runId,
          succeeded: args.succeeded,
          conversationId: args.conversationId,
        });
        if (result) finalized.set(args.runId, result.commitHash);
      },
      cancelRun: async (runId: string) => h.service.cancelSelfModRun(runId),
    };

    const context = {
      stellaAppDir: h.repoRoot,
      stellaDataDir: h.dataRoot,
      deviceId: "device-1",
      runtimeStore: {
        resolveOrCreateActiveThread: () => ({
          threadId: `thread-${++nextThread}`,
          reused: false,
        }),
        listActiveThreads: () => [],
        saveAgentRecord: vi.fn(),
        getAgentRecord: () => null,
      },
      appendLocalChatEvent: vi.fn(),
      state: {
        localAgentManager: null,
        runCallbacksByRunId: new Map(),
        conversationCallbacks: new Map(),
        convexSiteUrl: null,
        authToken: null,
        orchestratorSessions: new Map(),
      },
      selfModHmrController: h.controller,
      selfModLifecycle: lifecycle,
      toolHost,
      hookEmitter: { emit: vi.fn() },
      paths: {},
    } as any;

    (
      globalThis as unknown as { __selfModProductionHarness: HarnessDriver }
    ).__selfModProductionHarness = {
      runTool: async (surface, executor) =>
        await executor(
          "apply_patch",
          {
            input:
              surface === "subagent"
                ? patchFor(filePath, "original", "from-subagent")
                : [
                    "*** Begin Patch",
                    `*** Update File: ${filePath}`,
                    "@@",
                    "-export const second = 'original';",
                    "+export const second = 'from-orchestrator';",
                    "*** End Patch",
                    "",
                  ].join("\n"),
          },
          {
            conversationId: `${surface}-conversation`,
            deviceId: "device-1",
            requestId: `${surface}-request`,
            stellaAppDir: h.repoRoot,
          },
        ),
    };

    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });
    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "subagent-conversation",
      description: "subagent-x",
      prompt: "subagent-x",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await firstEntered;

    let orchestratorDoneResolve!: () => void;
    const orchestratorDone = new Promise<void>((resolve) => {
      orchestratorDoneResolve = resolve;
    });
    launchPreparedOrchestratorRun({
      context,
      prepared: {
        runId: "orchestrator-y",
        conversationId: "orchestrator-conversation",
        agentType: AGENT_IDS.INSTALL_UPDATE,
        userPrompt: "orchestrator-y",
        attachments: [],
        agentContext: {
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 1,
        },
        resolvedLlm: {
          model: { id: "test-model", provider: "test-provider" },
          route: "direct-provider",
          getApiKey: () => "test-key",
        },
        abortController: new AbortController(),
        selfModMetadata: { mode: "author" },
      },
      userMessageId: "orchestrator-user-message",
      runtimeCallbacks: { onEnd: () => orchestratorDoneResolve() },
      cleanupRun: () => {},
      onFatalError: (error) => {
        throw error;
      },
    } as any);

    const [subagent] = await Promise.all([
      waitForAgent(context.state.localAgentManager, threadId),
      orchestratorDone,
    ]);
    expect(subagent).toMatchObject({ status: "completed" });
    const selector = [...finalized.entries()].find(
      ([runId]) => runId !== "orchestrator-y",
    )?.[1];
    expect(selector).toBeTruthy();
    const orchestratorSelector = finalized.get("orchestrator-y");
    expect(orchestratorSelector).toBeTruthy();
    expect(h.service.getPreparedLogicalChangeSet(selector!)).toBeTruthy();
    expect(
      h.service.getPreparedLogicalChangeSet(orchestratorSelector!),
    ).toBeTruthy();
    const applied = await h.service.applyPreparedAuthorChange(selector!);
    expect(applied).toMatchObject({
      status: "applied",
      files: [
        expect.objectContaining({
          path: "desktop/src/shared.ts",
          state: expect.objectContaining({
            text: "export const value = 'from-subagent';\nexport const second = 'original';\n",
          }),
        }),
      ],
    });
    expect(
      await h.service.applyPreparedAuthorChange(orchestratorSelector!),
    ).toMatchObject({ status: "applied" });
    expect(git(h.repoRoot, ["show", "HEAD:desktop/src/shared.ts"])).toBe(
      "export const value = 'from-subagent';\nexport const second = 'from-orchestrator';\n",
    );
  });

  it("P0: independently attributes both wrapper changes in either apply order", async () => {
    await runIndependentWrapperAttribution(["subagent", "orchestrator"]);
    await runIndependentWrapperAttribution(["orchestrator", "subagent"]);
  });

  it("P1: serializes and isolates concurrent native external-engine (Codex) turns", async () => {
    await runNativeExternalEngineRace(["a", "b"]);
    await runNativeExternalEngineRace(["b", "a"]);
  });

  it("P1(a): attributes a Claude Bash-created file the engine never reported", async () => {
    const h = await createRepo();
    const createdRel = "desktop/src/created-by-bash.ts";
    const createdAbs = path.join(h.repoRoot, createdRel);
    const createdText = "export const createdByBash = true;\n";

    await runSingleExternalTurn(h, {
      conversationId: "claude-bash-create",
      agentEngine: "claude_code_local",
      driver: async () => {
        // Claude Bash-side `mkdir … && printf … > new-file`: lands in the tree
        // but is INVISIBLE to Claude's tool-event file collector.
        await mkdir(path.dirname(createdAbs), { recursive: true });
        await writeFile(createdAbs, createdText);
        return { fileChanges: [] } as ToolResult;
      },
    });

    const selector = selectorForConversation(h, "claude-bash-create");
    expect(selector).toBeTruthy();
    const frozen = h.service.getPreparedLogicalChangeSet(selector!);
    const created = frozen?.files.find((file) => file.path === createdRel);
    expect(created).toBeTruthy();
    expect(created?.base).toMatchObject({ kind: "missing" });
    expect(created?.incoming).toMatchObject({ text: createdText });

    expect(
      await h.coordinator.applyPendingWithMorph({ commitHash: selector! }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });
    expect(git(h.repoRoot, ["show", `HEAD:${createdRel}`])).toBe(createdText);
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
  });

  it("P1(b): captures a deletion performed during an external turn", async () => {
    const h = await createRepo();
    const rel = "desktop/src/doomed.ts";
    const abs = path.join(h.repoRoot, rel);
    await writeFile(abs, "export const doomed = 1;\n");
    git(h.repoRoot, ["add", rel]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed doomed"]);

    await runSingleExternalTurn(h, {
      conversationId: "codex-delete",
      driver: async () => {
        await rm(abs);
        return { fileChanges: [] } as ToolResult;
      },
    });

    const selector = selectorForConversation(h, "codex-delete");
    expect(selector).toBeTruthy();
    const frozen = h.service.getPreparedLogicalChangeSet(selector!);
    const deleted = frozen?.files.find((file) => file.path === rel);
    expect(deleted).toBeTruthy();
    expect(deleted?.incoming).toMatchObject({ kind: "missing" });

    expect(
      await h.coordinator.applyPendingWithMorph({ commitHash: selector! }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });
    expect(git(h.repoRoot, ["ls-files", rel]).trim()).toBe("");
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
  });

  it("P1(c): a nested Stella tool reuses the external lease without re-acquiring the lock", async () => {
    const h = await createRepo();
    const editedRel = "desktop/src/shared.ts";
    const editedAbs = path.join(h.repoRoot, editedRel);
    const bashRel = "desktop/src/bash-side.ts";
    const bashAbs = path.join(h.repoRoot, bashRel);
    let lockDuringNested = { locked: false, queued: 0 };

    await runSingleExternalTurn(h, {
      conversationId: "nested-reuse",
      executeTool: async (toolName, toolArgs, ctx) =>
        toolName === "apply_patch"
          ? await handleApplyPatch(toolArgs, ctx)
          : ({ result: "unused" } as ToolResult),
      driver: async (executor) => {
        // External Bash-side write (unreported by the engine).
        await writeFile(bashAbs, "export const bashSide = true;\n");
        // Nested Stella tool routed back through the REAL hmrAwareToolExecutor
        // while the external lease holds the (non-reentrant) lock. Must reuse
        // the lease instead of deadlocking on a second acquisition.
        const nested = await executor(
          "apply_patch",
          { input: patchFor(editedAbs, "original", "from-nested") },
          {
            conversationId: "nested-reuse",
            deviceId: "device-1",
            requestId: "nested-reuse-request",
            stellaAppDir: h.repoRoot,
          } as ToolContext,
        );
        lockDuringNested = getSelfModMutationLockStatus(h.repoRoot);
        return { fileChanges: nested.fileChanges ?? [] } as ToolResult;
      },
    });

    // Single owner throughout the nested call: the lease was reused, so no
    // second acquisition and nothing queued.
    expect(lockDuringNested.locked).toBe(true);
    expect(lockDuringNested.queued).toBe(0);

    const selector = selectorForConversation(h, "nested-reuse");
    expect(selector).toBeTruthy();
    const frozen = h.service.getPreparedLogicalChangeSet(selector!);
    const paths = (frozen?.files ?? []).map((file) => file.path).sort();
    // BOTH the Bash-side creation and the nested tool edit attribute to this run.
    expect(paths).toEqual([bashRel, editedRel].sort());
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
  });

  it("P1(d): a throw during the native turn still releases the mutation lock", async () => {
    const h = await createRepo();

    const failed = await runSingleExternalTurn(h, {
      conversationId: "throwing-turn",
      driver: async () => {
        await writeFile(path.join(h.repoRoot, "desktop/src/partial.ts"), "x\n");
        throw new Error("synthetic external engine failure");
      },
    });
    expect(failed.status).toBe("error");
    // Failed runs produce no pending changeset, and the lock is free.
    expect(selectorForConversation(h, "throwing-turn")).toBeUndefined();
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });

    // A subsequent external run still acquires the lock and commits.
    await runSingleExternalTurn(h, {
      conversationId: "after-throw",
      driver: async () => {
        await writeFile(path.join(h.repoRoot, "desktop/src/after.ts"), "y\n");
        return { fileChanges: [] } as ToolResult;
      },
    });
    expect(selectorForConversation(h, "after-throw")).toBeTruthy();
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
  });

  it("P1(e): a capture-finalization failure does NOT leak the mutation lock", async () => {
    const h = await createRepo();
    let failNextFinish = true;
    const lifecycle = {
      ...h.coordinator.lifecycle,
      finishMediatedWrite: async (
        finishArgs: Parameters<
          typeof h.coordinator.lifecycle.finishMediatedWrite
        >[0],
      ) => {
        if (failNextFinish) {
          failNextFinish = false;
          throw new Error("synthetic capture finalization failure");
        }
        return await h.coordinator.lifecycle.finishMediatedWrite(finishArgs);
      },
    };

    await runSingleExternalTurn(h, {
      conversationId: "finish-throws",
      selfModLifecycle: lifecycle,
      driver: async () => {
        await writeFile(path.join(h.repoRoot, "desktop/src/e.ts"), "z\n");
        return { fileChanges: [] } as ToolResult;
      },
    });

    // The exact P0 repro: finishMediatedWrite threw, but the non-reentrant lock
    // MUST have been released regardless.
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
    expect(failNextFinish).toBe(false);

    // The lock is genuinely free: a subsequent run proceeds and commits.
    await runSingleExternalTurn(h, {
      conversationId: "finish-after",
      driver: async () => {
        await writeFile(path.join(h.repoRoot, "desktop/src/after-e.ts"), "w\n");
        return { fileChanges: [] } as ToolResult;
      },
    });
    expect(selectorForConversation(h, "finish-after")).toBeTruthy();
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
  });

  it("P1(f): external HMR path set is exactly this run's delta, not pre-existing dirt", async () => {
    const h = await createRepo();
    // Unrelated tracked file left DIRTY vs HEAD before the turn (stands in for
    // another active/pending run's earlier writes, or unrelated pre-existing
    // dirt the lock can't distinguish from this run's work).
    const dirtyTrackedRel = "desktop/src/preexisting-dirty.ts";
    const dirtyTrackedAbs = path.join(h.repoRoot, dirtyTrackedRel);
    await writeFile(dirtyTrackedAbs, "export const clean = 1;\n");
    git(h.repoRoot, ["add", dirtyTrackedRel]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed preexisting"]);
    await writeFile(dirtyTrackedAbs, "export const clean = 999;\n");
    // Unrelated UNTRACKED file present before the turn.
    const dirtyUntrackedRel = "desktop/src/preexisting-untracked.ts";
    const dirtyUntrackedAbs = path.join(h.repoRoot, dirtyUntrackedRel);
    await writeFile(dirtyUntrackedAbs, "export const stray = true;\n");

    const ownRel = "desktop/src/own-delta.ts";
    const ownAbs = path.join(h.repoRoot, ownRel);
    const ownText = "export const own = true;\n";

    await runSingleExternalTurn(h, {
      conversationId: "isolated-delta",
      agentEngine: "claude_code_local",
      driver: async () => {
        // The run authors EXACTLY one file; it never touches the pre-existing
        // dirty paths.
        await writeFile(ownAbs, ownText);
        return { fileChanges: [] } as ToolResult;
      },
    });

    const selector = selectorForConversation(h, "isolated-delta");
    expect(selector).toBeTruthy();
    const frozen = h.service.getPreparedLogicalChangeSet(selector!);
    expect((frozen?.files ?? []).map((file) => file.path)).toEqual([ownRel]);

    expect(
      await h.coordinator.applyPendingWithMorph({ commitHash: selector! }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });

    // The HMR apply path set contains ONLY the run's own delta — never the
    // pre-existing dirty paths.
    const applyPaths = (
      h.applyPayloads.at(-1) as {
        runs: Array<{ paths?: string[]; files?: Array<{ path: string }> }>;
      }
    ).runs.flatMap((run) => [
      ...(run.paths ?? []),
      ...(run.files ?? []).map((file) => file.path),
    ]);
    expect(applyPaths.some((p) => p.includes("own-delta"))).toBe(true);
    expect(applyPaths.some((p) => p.includes("preexisting-dirty"))).toBe(false);
    expect(applyPaths.some((p) => p.includes("preexisting-untracked"))).toBe(
      false,
    );

    // The run owned/committed only its delta; pre-existing dirt stays dirty on
    // disk and its committed content is unchanged (this run never snapshotted,
    // pinned, or applied it).
    expect(git(h.repoRoot, ["show", `HEAD:${ownRel}`])).toBe(ownText);
    expect(git(h.repoRoot, ["show", `HEAD:${dirtyTrackedRel}`])).toBe(
      "export const clean = 1;\n",
    );
    expect(await readFile(dirtyTrackedAbs, "utf8")).toBe(
      "export const clean = 999;\n",
    );
    expect(await readFile(dirtyUntrackedAbs, "utf8")).toBe(
      "export const stray = true;\n",
    );
  });

  it("P0: selector, update-all, discard, and restart use strict V2 overlays", async () => {
    const h = await createRepo();
    const relativePath = "desktop/src/shared.ts";
    const filePath = path.join(h.repoRoot, relativePath);

    await beginAuthorRun(h, "run-x");
    await beginAuthorRun(h, "run-y");
    await beginAuthorRun(h, "run-z");
    await writeAuthorText(
      h,
      "run-x",
      relativePath,
      "export const value = 'from-x';\n",
    );
    const liveCombined =
      "export const value = 'from-x';\nexport const pendingY = true;\n";
    await writeAuthorText(h, "run-y", relativePath, liveCombined);
    await writeAuthorText(
      h,
      "run-z",
      "desktop/src/z.ts",
      "export const z = true;\n",
    );
    const selectorX = await finalizeAuthorRun(h, "run-x");
    await finalizeAuthorRun(h, "run-y");
    await finalizeAuthorRun(h, "run-z");

    expect(
      await h.coordinator.applyPendingWithMorph({ commitHash: selectorX }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });
    expect(h.applyPayloads.at(-1)).toMatchObject({
      runs: [
        expect.objectContaining({
          runId: "run-x",
          protocolVersion: 2,
          paths: [relativePath],
          files: [
            expect.objectContaining({
              path: relativePath,
              state: expect.objectContaining({
                kind: "blob",
                text: "export const value = 'from-x';\n",
              }),
            }),
          ],
        }),
      ],
    });
    expect(h.overlayReadyPaths).toContainEqual([relativePath]);
    const selectedOverlay = h.overlayServedReads.at(-1);
    expect(selectedOverlay).toMatchObject({ path: relativePath, status: 200 });
    expect(selectedOverlay?.content).toContain("from-x");
    expect(selectedOverlay?.content).not.toContain("pendingY");
    expect(await readFile(filePath, "utf8")).toBe(liveCombined);

    const transitionCountBeforeUpdateAll = h.hostRequests.filter(
      (request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    ).length;
    const updateAllResults = await h.coordinator.applyAllPendingWithMorph();
    expect(updateAllResults).toEqual([
      expect.objectContaining({ applied: true }),
      expect.objectContaining({ applied: true }),
    ]);
    const updateAllTransitions = h.hostRequests
      .filter(
        (request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
      )
      .slice(transitionCountBeforeUpdateAll);
    expect(updateAllTransitions).toHaveLength(2);
    for (const transition of updateAllTransitions) {
      expect(
        await h.coordinator.resumeTransition({
          transitionId: (transition.params as { transitionId: string })
            .transitionId,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(h.applyPayloads.slice(-2)).toEqual([
      expect.objectContaining({
        runs: [expect.objectContaining({ runId: "run-y", protocolVersion: 2 })],
      }),
      expect.objectContaining({
        runs: [expect.objectContaining({ runId: "run-z", protocolVersion: 2 })],
      }),
    ]);
    expect(
      h.overlayServedReads.some((read) => read.content.includes("pendingY")),
    ).toBe(true);
    expect(h.overlayServedReads.at(-1)?.content).toContain("z = true");
    expect(git(h.repoRoot, ["show", `HEAD:${relativePath}`])).toBe(
      liveCombined,
    );

    const payloadCountBeforeDiscard = h.applyPayloads.length;
    await beginAuthorRun(h, "run-discard");
    await writeAuthorText(
      h,
      "run-discard",
      relativePath,
      `${liveCombined}export const discarded = true;\n`,
    );
    const discardSelector = await finalizeAuthorRun(h, "run-discard");
    expect(
      await h.coordinator.discardPending({ commitHash: discardSelector }),
    ).toMatchObject({ discarded: true });
    expect(await readFile(filePath, "utf8")).toBe(liveCombined);
    expect(h.applyPayloads).toHaveLength(payloadCountBeforeDiscard);

    await writeFile(
      path.join(h.repoRoot, "package.json"),
      '{"name":"before"}\n',
    );
    git(h.repoRoot, ["add", "package.json"]);
    git(h.repoRoot, ["commit", "-q", "-m", "seed package"]);
    await beginAuthorRun(h, "run-restart");
    await beginAuthorRun(h, "run-live");
    await writeAuthorText(
      h,
      "run-restart",
      "package.json",
      '{"name":"after"}\n',
    );
    await writeAuthorText(
      h,
      "run-live",
      "desktop/src/live.ts",
      "export const live = true;\n",
    );
    const restartSelector = await finalizeAuthorRun(h, "run-restart");
    const liveSelector = await finalizeAuthorRun(h, "run-live");
    expect(
      await h.coordinator.applyPendingWithMorph({
        commitHash: restartSelector,
      }),
    ).toMatchObject({ applied: true });
    expect(await resumeLatestTransition(h)).toMatchObject({ ok: true });
    expect(await readFile(path.join(h.repoRoot, "package.json"), "utf8")).toBe(
      '{"name":"after"}\n',
    );
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/live.ts"), "utf8"),
    ).toBe("export const live = true;\n");
    expect(h.applyPayloads).toHaveLength(payloadCountBeforeDiscard);
    expect(await h.controller.getStatus()).toMatchObject({ inFlightPaths: 1 });
    expect(
      await h.coordinator.discardPending({ commitHash: liveSelector }),
    ).toMatchObject({ discarded: true });
    expect(await h.controller.getStatus()).toMatchObject({
      inFlightPaths: 0,
      appliedOverlayPaths: 0,
    });
  });

  it("retains an orchestrator shell capture through the real long-running lease", async () => {
    const h = await createRepo();
    const filePath = path.join(h.repoRoot, "desktop/src/shared.ts");
    const applyPayloads: unknown[] = [];
    // Observe the actual controller payload while still posting it to the
    // real Vite plugin endpoint.
    const observedController = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => h.devServerUrl,
      repoRoot: h.repoRoot,
      observeApplyPayload: (payload) => applyPayloads.push(payload),
    });
    const pending = new Map<string, PendingSelfModApply>();
    const hostRequests: Array<{ method: string; params: unknown }> = [];
    const coordinator = createSelfModCoordinator({
      peer: {
        notify: () => {},
        request: async <TResult>(method: string, params?: unknown) => {
          hostRequests.push({ method, params });
          return {} as TResult;
        },
        registerRequestHandler: () => {},
        registerNotificationHandler: () => {},
      } as any,
      getController: () => observedController,
      getStoreModService: () => h.service,
      getRuntimeStore: () => null,
      getRepoRoot: () => h.repoRoot,
      getPendingSelfModApplies: () => pending,
      patchSelfModApplyStatus: () => {},
    });
    const toolHost = {
      getToolCatalog: () => [],
      executeTool: async (
        toolName: string,
        args: Record<string, unknown>,
        context: ToolContext,
      ) => {
        if (toolName === "exec_command") {
          await writeFile(filePath, "export const value = 'early';\n");
          return { details: { session_id: "lease-1", running: true } };
        }
        if (toolName === "write_stdin") {
          await writeFile(filePath, "export const value = 'late';\n");
          return {
            details: { session_id: "lease-1", running: false },
            fileChanges: [
              { path: filePath, kind: { type: "update" as const } },
            ],
          };
        }
        if (toolName === "apply_patch")
          return await handleApplyPatch(args, context);
        return { result: "unused" };
      },
      registerExtensionTools: vi.fn(),
      drainCompletedShellProducedFiles: vi.fn(async () => []),
      killAllShells: vi.fn(),
      killShell: vi.fn(),
      killShellsByPort: vi.fn(),
      shutdown: vi.fn(),
    };
    const context = {
      stellaAppDir: h.repoRoot,
      stellaDataDir: h.dataRoot,
      deviceId: "device-1",
      runtimeStore: {},
      state: {
        runCallbacksByRunId: new Map(),
        conversationCallbacks: new Map(),
        convexSiteUrl: null,
        authToken: null,
        orchestratorSessions: new Map(),
      },
      selfModHmrController: observedController,
      selfModLifecycle: coordinator.lifecycle,
      toolHost,
      hookEmitter: { emit: vi.fn() },
      paths: {},
    } as any;
    (
      globalThis as unknown as { __selfModProductionHarness: HarnessDriver }
    ).__selfModProductionHarness = {
      runTool: async (surface, executor) => {
        expect(surface).toBe("orchestrator");
        const execResult = await executor(
          "exec_command",
          { cmd: "synthetic background mutation" },
          {
            conversationId: "shell-conversation",
            deviceId: "device-1",
            requestId: "shell-exec",
            stellaAppDir: h.repoRoot,
          },
        );
        expect(execResult).toMatchObject({
          details: { session_id: "lease-1", running: true },
        });
        expect(getSelfModMutationLockStatus(h.repoRoot).locked).toBe(true);
        const nested = await executor(
          "apply_patch",
          {
            input: [
              "*** Begin Patch",
              `*** Add File: ${path.join(h.repoRoot, "desktop/src/lease-extra.ts")}`,
              "+export const extra = true;",
              "*** End Patch",
              "",
            ].join("\n"),
          },
          {
            conversationId: "shell-conversation",
            deviceId: "device-1",
            requestId: "nested-write",
            stellaAppDir: h.repoRoot,
          },
        );
        expect(nested.error).toBeUndefined();
        return await executor(
          "write_stdin",
          { session_id: "lease-1", chars: "" },
          {
            conversationId: "shell-conversation",
            deviceId: "device-1",
            requestId: "shell-poll",
            stellaAppDir: h.repoRoot,
          },
        );
      },
    };

    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => (doneResolve = resolve));
    launchPreparedOrchestratorRun({
      context,
      prepared: {
        runId: "shell-run",
        conversationId: "shell-conversation",
        agentType: AGENT_IDS.INSTALL_UPDATE,
        userPrompt: "long shell",
        attachments: [],
        agentContext: {
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 1,
        },
        resolvedLlm: {
          model: { id: "test-model", provider: "test-provider" },
          route: "direct-provider",
          getApiKey: () => "test-key",
        },
        abortController: new AbortController(),
        selfModMetadata: { mode: "author" },
      },
      userMessageId: "shell-user-message",
      runtimeCallbacks: { onEnd: () => doneResolve() },
      cleanupRun: () => {},
      onFatalError: (error) => {
        throw error;
      },
    } as any);
    await done;
    expect(getSelfModMutationLockStatus(h.repoRoot)).toEqual({
      locked: false,
      queued: 0,
    });
    const selector = [...pending.keys()][0];
    expect(selector).toBeTruthy();
    expect(
      await coordinator.applyPendingWithMorph({ commitHash: selector }),
    ).toMatchObject({ applied: true });
    const transition = hostRequests.find(
      (request) => request.method === METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    );
    expect(transition).toBeTruthy();
    await coordinator.resumeTransition({
      transitionId: (transition!.params as { transitionId: string })
        .transitionId,
    });
    expect(git(h.repoRoot, ["show", "HEAD:desktop/src/shared.ts"])).toBe(
      "export const value = 'late';\n",
    );
    expect(git(h.repoRoot, ["show", "HEAD:desktop/src/lease-extra.ts"])).toBe(
      "export const extra = true;\n",
    );
    expect(applyPayloads.at(-1)).toMatchObject({
      runs: [
        expect.objectContaining({
          protocolVersion: 2,
          files: expect.arrayContaining([
            expect.objectContaining({
              path: "desktop/src/lease-extra.ts",
              state: expect.objectContaining({
                text: "export const extra = true;\n",
              }),
            }),
            expect.objectContaining({
              state: expect.objectContaining({
                text: "export const value = 'late';\n",
              }),
            }),
          ]),
        }),
      ],
    });
  });
});
