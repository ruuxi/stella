import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const modelListing = vi.hoisted(() =>
  vi.fn(async () => ({
    revision: 7,
    models: [
      { id: "gemini-test", provider: "google" },
      { id: "openrouter-test", provider: "openrouter" },
    ],
    runtimeManagedProviders: [],
    refreshedAt: null,
  })),
);

vi.mock("../../../../runtime/ai/model-runtime.js", () => ({
  modelRuntime: {
    onCatalogChanged: vi.fn(() => () => undefined),
    getSnapshotForListing: modelListing,
  },
}));

vi.mock("../../../../runtime/kernel/storage/database.js", () => ({
  createDesktopDatabase: vi.fn(),
}));

vi.mock("../../../../runtime/worker/required-cli-bridge.js", () => ({
  connectorActionBrokerAvailability: () => ({
    supported: false,
    reason: "disabled in worker migration test",
  }),
  afterRequiredCliBridgeReady: async (
    _start: () => Promise<void>,
    ready: () => unknown,
  ) => ready(),
}));

vi.mock("../../../../runtime/kernel/runner.js", () => ({
  createStellaHostRunner: () => ({
    setConvexUrl: vi.fn(),
    setConvexSiteUrl: vi.fn(),
    setAuthToken: vi.fn(),
    setHasConnectedAccount: vi.fn(),
    setCloudSyncEnabled: vi.fn(),
    setModelCatalogUpdatedAt: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    waitUntilInitialized: vi.fn(async () => undefined),
    warmModelCatalog: vi.fn(async () => undefined),
    agentHealthCheck: () => ({ ready: true }),
    getActiveOrchestratorRun: () => null,
    listActiveAgentRuns: () => [],
    getActiveAgentCount: () => 0,
  }),
}));

import { createDesktopDatabase } from "../../../../runtime/kernel/storage/database.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import {
  METHOD_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
} from "../../../../runtime/protocol/index.js";
import type { WorkerPeerLike } from "../../../../runtime/worker/peer-broker.js";
import { createRuntimeWorkerServer } from "../../../../runtime/worker/server.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.mocked(createDesktopDatabase).mockReset();
  modelListing.mockClear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worker model listing with a legacy self-mod database", () => {
  it("initializes, archives the old payload ledger, and reaches listModels", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-worker-model-list-migration-"),
    );
    tempDirs.push(root);
    const appDir = path.join(root, "app");
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const databasePath = getDesktopDatabasePath(dataDir);
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      CREATE TABLE self_mod_pending_change_sets (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO self_mod_pending_change_sets VALUES (
        'legacy-worker-row',
        '${appDir.replaceAll("'", "''")}',
        '{"workerLegacy":true}',
        10,
        20
      );
    `);
    legacyDb.close();

    vi.mocked(createDesktopDatabase).mockImplementation(() => {
      const opened = new DatabaseSync(
        databasePath,
      ) as unknown as SqliteDatabase;
      initializeDesktopDatabase(opened);
      return opened;
    });

    const requestHandlers = new Map<
      string,
      (params: unknown) => Promise<unknown> | unknown
    >();
    const peer: WorkerPeerLike = {
      notify: vi.fn(),
      request: vi.fn(async (method: string) => {
        if (method === METHOD_NAMES.HOST_DEVICE_IDENTITY_GET) {
          return { deviceId: "device-migration", publicKey: "public-key" };
        }
        throw new Error(`Unexpected host request: ${method}`);
      }) as WorkerPeerLike["request"],
      registerRequestHandler: (method, handler) => {
        requestHandlers.set(method, handler);
      },
      registerNotificationHandler: vi.fn(),
    };
    const worker = createRuntimeWorkerServer(peer);

    await requestHandlers.get(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE)?.({
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
      stellaAppDir: appDir,
      stellaDataDirPath: dataDir,
      stellaWorkspacePath: workspaceDir,
      authToken: null,
      convexUrl: null,
      convexSiteUrl: null,
      hasConnectedAccount: false,
      cloudSyncEnabled: false,
      modelCatalogUpdatedAt: null,
    });
    const snapshot = await requestHandlers.get(
      METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS,
    )?.({ forceRefresh: false });
    const refreshedSnapshot = await requestHandlers.get(
      METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS,
    )?.({ forceRefresh: true });

    expect(snapshot).toMatchObject({
      revision: 7,
      models: [
        { id: "gemini-test", provider: "google" },
        { id: "openrouter-test", provider: "openrouter" },
      ],
    });
    expect(refreshedSnapshot).toEqual(snapshot);
    expect(modelListing.mock.calls).toEqual([
      [{ forceRefresh: false }],
      [{ forceRefresh: true }],
    ]);
    await worker.shutdown();

    const verified = new DatabaseSync(databasePath);
    expect(
      verified
        .prepare(
          `SELECT payload_json
           FROM self_mod_pending_change_sets_legacy_v1
           WHERE change_set_id = ?`,
        )
        .get("legacy-worker-row"),
    ).toEqual({ payload_json: '{"workerLegacy":true}' });
    expect(
      verified
        .prepare("PRAGMA table_info(self_mod_pending_change_sets);")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        "conversation_id",
        "owner_thread_id",
        "completion_event_id",
        "assistant_message_event_id",
        "status",
      ]),
    );
    expect(verified.prepare("PRAGMA foreign_key_check;").all()).toEqual([]);
    verified.close();
  });
});
