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
  runSubagentTask: vi.fn(async (opts: {
    toolExecutor: HarnessDriver["runTool"] extends (
      surface: never,
      executor: infer T,
    ) => unknown
      ? T
      : never;
  }) => {
    const result = await getDriver().runTool("subagent", opts.toolExecutor);
    return {
      runId: "subagent-run",
      result: result.error ? "" : "done",
      error: result.error,
      fileChanges: result.fileChanges,
      producedFiles: result.producedFiles,
    };
  }),
  runOrchestratorTurn: vi.fn(async (opts: {
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
    const result = await getDriver().runTool("orchestrator", opts.toolExecutor);
    await opts.beforeRunEnd?.();
    opts.callbacks.onEnd?.({
      type: "run_finished",
      runId: opts.runId,
      agentType: opts.agentType,
      seq: 1,
      finalText: result.error ? "" : "done",
      timestamp: Date.now(),
    });
  }),
}));

const roots: string[] = [];
const servers: ViteDevServer[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  delete (globalThis as unknown as { __selfModProductionHarness?: HarnessDriver })
    .__selfModProductionHarness;
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
      if (!address || typeof address === "string") return reject(new Error("No port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const createRepo = async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-prod-harness-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "stella-prod-harness-db-"));
  roots.push(repoRoot, dataRoot);
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "desktop/src"), { recursive: true });
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

  const previousMode = process.env.STELLA_SELF_MOD_HMR_MODE;
  process.env.STELLA_SELF_MOD_HMR_MODE = "live";
  const port = await reservePort();
  const server = await createServer({
    root: repoRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: [selfModHmrControl({ repoRoot })],
  });
  if (previousMode === undefined) delete process.env.STELLA_SELF_MOD_HMR_MODE;
  else process.env.STELLA_SELF_MOD_HMR_MODE = previousMode;
  servers.push(server);
  await server.listen();
  const devServerUrl = server.resolvedUrls?.local[0];
  if (!devServerUrl) throw new Error("Vite harness did not resolve a URL.");
  const controller = createSelfModHmrController({
    enabled: true,
    getDevServerUrl: () => devServerUrl,
    repoRoot,
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

describe("production-path self-mod concurrency harness", () => {
  it("P0: serializes one subagent apply_patch transaction against an orchestrator mutation", async () => {
    const h = await createRepo();
    const filePath = path.join(h.repoRoot, "desktop/src/shared.ts");
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
      beginRun: async (args: { runId: string; mode?: string; taskDescription: string }) => {
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
        await h.service.finishMediatedWrite(
          args.capture,
          args.additionalPaths,
        ),
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

    (globalThis as unknown as { __selfModProductionHarness: HarnessDriver })
      .__selfModProductionHarness = {
      runTool: async (surface, executor) =>
        await executor(
          "apply_patch",
          {
            input:
              surface === "subagent"
                ? patchFor(filePath, "original", "from-subagent")
                : patchFor(filePath, "from-subagent", "from-orchestrator"),
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

    const [subagent] = await Promise.all([
      waitForAgent(context.state.localAgentManager, threadId),
      orchestratorDone,
    ]);
    expect(subagent).toMatchObject({ status: "completed" });
    const selector = [...finalized.values()][0];
    expect(selector).toBeTruthy();
    const orchestratorSelector = finalized.get("orchestrator-y");
    expect(orchestratorSelector).toBeTruthy();
    h.service.discardPreparedAuthorChange(orchestratorSelector!);
    const applied = await h.service.applyPreparedAuthorChange(selector!);
    expect(applied).toMatchObject({
      status: "applied",
      files: [
        expect.objectContaining({
          path: "desktop/src/shared.ts",
          state: expect.objectContaining({
            text: "export const value = 'from-subagent';\n",
          }),
        }),
      ],
    });
  });

  it("P0: real Vite apply keeps every other run's shared-disk bytes", async () => {
    const h = await createRepo();
    const relativePath = "desktop/src/shared.ts";
    const filePath = path.join(h.repoRoot, relativePath);
    await h.controller.beginRun("run-x");
    await h.controller.recordWrite("run-x", [filePath], {
      captureSnapshot: false,
    });
    const liveCombined =
      "export const value = 'from-x';\nexport const pendingY = true;\n";
    await writeFile(filePath, liveCombined);
    const response = await h.controller.apply([
      {
        runId: "run-x",
        paths: [relativePath],
        files: [
          {
            path: relativePath,
            content: "export const value = 'from-x';\n",
          },
        ],
        runtimeRestartRelevantPaths: [],
        processRestartRelevantPaths: [],
        restartRelevantPaths: [],
        fullReloadRelevantPaths: [],
      },
    ]);
    expect(response.ok).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe(liveCombined);
    const status = await h.controller.getStatus();
    expect(status).toMatchObject({
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
            fileChanges: [{ path: filePath, kind: { type: "update" as const } }],
          };
        }
        if (toolName === "apply_patch") return await handleApplyPatch(args, context);
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
    (globalThis as unknown as { __selfModProductionHarness: HarnessDriver })
      .__selfModProductionHarness = {
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
        agentContext: { systemPrompt: "", dynamicContext: "", maxAgentDepth: 1 },
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
      transitionId: (transition!.params as { transitionId: string }).transitionId,
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
              state: expect.objectContaining({ text: "export const extra = true;\n" }),
            }),
            expect.objectContaining({
              state: expect.objectContaining({ text: "export const value = 'late';\n" }),
            }),
          ]),
        }),
      ],
    });
  });
});
