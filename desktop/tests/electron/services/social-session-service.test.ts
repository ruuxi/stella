import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiTokens, convexState } = vi.hoisted(() => ({
  apiTokens: {
    social: {
      sessions: {
        listMySessions: "listMySessions",
        listPendingTurnsForHostDevice: "listPendingTurnsForHostDevice",
        claimTurn: "claimTurn",
        completeTurn: "completeTurn",
        failTurn: "failTurn",
        releaseTurn: "releaseTurn",
        listFileOpsSince: "listFileOpsSince",
        acknowledgeFileOps: "acknowledgeFileOps",
        uploadFileOp: "uploadFileOp",
      },
    },
  },
  convexState: {
    deploymentUrl: null as string | null,
    authProvider: null as (() => Promise<string | null>) | null,
    subscription: null as
      | {
          onUpdate: (payload: unknown) => void;
          onError: (error: Error) => void;
          unsubscribe: ReturnType<typeof vi.fn>;
        }
      | null,
    queryMock: vi.fn(async () => []),
    mutationMock: vi.fn(async () => ({})),
    actionMock: vi.fn(async () => ({})),
    closeMock: vi.fn(async () => {}),
  },
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class MockConvexClient {
    constructor(url: string) {
      convexState.deploymentUrl = url;
    }

    setAuth(provider: () => Promise<string | null>) {
      convexState.authProvider = provider;
    }

    onUpdate(
      _query: unknown,
      _args: Record<string, unknown>,
      onUpdate: (payload: unknown) => void,
      onError: (error: Error) => void,
    ) {
      const unsubscribe = vi.fn(() => {
        convexState.subscription = null;
      });
      convexState.subscription = {
        onUpdate,
        onError,
        unsubscribe,
      };
      return { unsubscribe };
    }

    query(query: unknown, args: Record<string, unknown>) {
      return convexState.queryMock(query, args);
    }

    mutation(mutation: unknown, args: Record<string, unknown>) {
      return convexState.mutationMock(mutation, args);
    }

    action(action: unknown, args: Record<string, unknown>) {
      return convexState.actionMock(action, args);
    }

    close() {
      return convexState.closeMock();
    }
  },
}));

vi.mock("../../../src/convex/api.js", () => ({
  api: apiTokens,
}));

import { SocialSessionService } from "../../../packages/stella-runtime-worker/src/social-sessions/service.js";

type SessionRecord = {
  sessionId: string;
  localFolderPath: string;
  localFolderName: string;
  role: "host" | "follower";
  lastAppliedFileOpOrdinal: number;
  lastObservedTurnOrdinal: number;
  updatedAt: number;
};

class MemorySocialSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly files = new Map<string, Map<string, {
    sessionId: string;
    relativePath: string;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
    updatedAt: number;
  }>>();

  getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  upsertSession(record: Omit<SessionRecord, "updatedAt"> & { updatedAt?: number }) {
    const nextRecord: SessionRecord = {
      ...record,
      updatedAt: record.updatedAt ?? Date.now(),
    };
    this.sessions.set(record.sessionId, nextRecord);
    return nextRecord;
  }

  patchSession(sessionId: string, patch: Partial<Omit<SessionRecord, "sessionId" | "updatedAt">>) {
    const existing = this.getSession(sessionId);
    if (!existing) {
      return null;
    }
    return this.upsertSession({
      sessionId,
      localFolderPath: patch.localFolderPath ?? existing.localFolderPath,
      localFolderName: patch.localFolderName ?? existing.localFolderName,
      role: patch.role ?? existing.role,
      lastAppliedFileOpOrdinal:
        patch.lastAppliedFileOpOrdinal ?? existing.lastAppliedFileOpOrdinal,
      lastObservedTurnOrdinal:
        patch.lastObservedTurnOrdinal ?? existing.lastObservedTurnOrdinal,
    });
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.files.delete(sessionId);
  }

  listFiles(sessionId: string) {
    return [...(this.files.get(sessionId)?.values() ?? [])];
  }

  upsertFile(record: {
    sessionId: string;
    relativePath: string;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
    updatedAt?: number;
  }) {
    const bucket = this.files.get(record.sessionId) ?? new Map();
    this.files.set(record.sessionId, bucket);
    const nextRecord = {
      ...record,
      updatedAt: record.updatedAt ?? Date.now(),
    };
    bucket.set(record.relativePath, nextRecord);
    return nextRecord;
  }

  removeFile(sessionId: string, relativePath: string) {
    this.files.get(sessionId)?.delete(relativePath);
  }
}

const tempRoots: string[] = [];

const createTempWorkspaceRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-social-session-service-"));
  tempRoots.push(root);
  return root;
};

const flushMicrotasks = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("SocialSessionService", () => {
  beforeEach(() => {
    convexState.deploymentUrl = null;
    convexState.authProvider = null;
    convexState.subscription = null;
    convexState.queryMock.mockReset();
    convexState.queryMock.mockImplementation(async () => []);
    convexState.mutationMock.mockReset();
    convexState.mutationMock.mockImplementation(async () => ({}));
    convexState.actionMock.mockReset();
    convexState.actionMock.mockImplementation(async () => ({}));
    convexState.closeMock.mockReset();
    convexState.closeMock.mockImplementation(async () => {});
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles subscribed sessions into local folders and service snapshots", async () => {
    const workspaceRoot = createTempWorkspaceRoot();
    const store = new MemorySocialSessionStore();
    const service = new SocialSessionService({
      getWorkspaceRoot: () => workspaceRoot,
      getDeviceId: () => "device-1",
      getRunner: () => null,
      getChatStore: () => null,
      getStore: () => store as never,
    });

    service.setConvexUrl("https://demo.convex.cloud");
    service.setAuthToken("token-1");
    service.start();

    expect(convexState.deploymentUrl).toBe("https://demo.convex.cloud");
    expect(await convexState.authProvider?.()).toBe("token-1");

    convexState.subscription?.onUpdate([
      {
        session: {
          _id: "session-1",
          hostOwnerId: "owner-1",
          hostDeviceId: "device-1",
          workspaceFolderName: "Pair Session",
          conversationId: "conversation-1",
          status: "active",
        },
        membership: {
          ownerId: "owner-2",
        },
      },
    ]);
    await flushMicrotasks();

    await vi.waitFor(() => {
      expect(service.getSnapshot().sessionCount).toBe(1);
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.status).toBe("running");
    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        role: "follower",
        hostDeviceId: "device-1",
        isActiveHost: false,
        localFolderName: "Pair Session",
      }),
    ]);

    const persisted = store.getSession("session-1");
    expect(persisted?.localFolderPath).toContain("Pair Session-session-");
    expect(fs.existsSync(persisted!.localFolderPath)).toBe(true);

    service.stop();
  });

  it("claims and runs pending host turns through the local orchestrator", async () => {
    const workspaceRoot = createTempWorkspaceRoot();
    const store = new MemorySocialSessionStore();
    const appendEvent = vi.fn();
    const onLocalChatUpdated = vi.fn();
    const runAutomationTurn = vi.fn(async () => ({
      status: "ok" as const,
      finalText: "All set",
    }));
    const service = new SocialSessionService({
      getWorkspaceRoot: () => workspaceRoot,
      getDeviceId: () => "device-1",
      getRunner: () =>
        ({
          getActiveOrchestratorRun: () => null,
          runAutomationTurn,
        }) as never,
      getChatStore: () =>
        ({
          appendEvent,
        }) as never,
      getStore: () => store as never,
      onLocalChatUpdated,
    });

    convexState.queryMock.mockImplementation(async (query: unknown) => {
      if (query === apiTokens.social.sessions.listPendingTurnsForHostDevice) {
        return [
          {
            session: {
              _id: "session-1",
              conversationId: "conversation-1",
            },
            turn: {
              _id: "turn-1",
              ordinal: 4,
              prompt: "Add a helper",
              requestId: "request-1",
              agentType: "general",
            },
          },
        ];
      }
      if (query === apiTokens.social.sessions.listFileOpsSince) {
        return [];
      }
      return [];
    });
    convexState.mutationMock.mockImplementation(async (mutation: unknown) => {
      if (mutation === apiTokens.social.sessions.claimTurn) {
        return { claimed: true };
      }
      return {};
    });

    service.setConvexUrl("https://demo.convex.cloud");
    service.setAuthToken("token-1");
    service.start();

    convexState.subscription?.onUpdate([
      {
        session: {
          _id: "session-1",
          hostOwnerId: "owner-1",
          hostDeviceId: "device-1",
          workspaceFolderName: "Host Session",
          conversationId: "conversation-1",
          status: "active",
        },
        membership: {
          ownerId: "owner-1",
        },
      },
    ]);
    await flushMicrotasks();

    await (service as any).runTick();

    expect(runAutomationTurn).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      userPrompt: "Add a helper",
      agentType: "general",
    });
    expect(convexState.mutationMock).toHaveBeenCalledWith(
      apiTokens.social.sessions.claimTurn,
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        deviceId: "device-1",
      }),
    );
    expect(convexState.mutationMock).toHaveBeenCalledWith(
      apiTokens.social.sessions.completeTurn,
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        deviceId: "device-1",
        resultText: "All set",
      }),
    );
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(onLocalChatUpdated).toHaveBeenCalledTimes(1);
    expect(store.getSession("session-1")?.lastObservedTurnOrdinal).toBe(4);
    expect(service.getSnapshot().processingTurnId).toBeUndefined();

    service.stop();
  });

  it.each([
    {
      status: "busy" as const,
      response: { status: "busy" as const, finalText: "", error: "runner busy" },
      expectedMutation: "releaseTurn",
    },
    {
      status: "error" as const,
      response: { status: "error" as const, finalText: "", error: "runner failed" },
      expectedMutation: "failTurn",
    },
  ])(
    "broadcasts local chat updates when a claimed host turn returns $status",
    async ({ response, expectedMutation }) => {
      const workspaceRoot = createTempWorkspaceRoot();
      const store = new MemorySocialSessionStore();
      const appendEvent = vi.fn();
      const onLocalChatUpdated = vi.fn();
      const runAutomationTurn = vi.fn(async () => response);
      const service = new SocialSessionService({
        getWorkspaceRoot: () => workspaceRoot,
        getDeviceId: () => "device-1",
        getRunner: () =>
          ({
            getActiveOrchestratorRun: () => null,
            runAutomationTurn,
          }) as never,
        getChatStore: () =>
          ({
            appendEvent,
          }) as never,
        getStore: () => store as never,
        onLocalChatUpdated,
      });

      convexState.queryMock.mockImplementation(async (query: unknown) => {
        if (query === apiTokens.social.sessions.listPendingTurnsForHostDevice) {
          return [
            {
              session: {
                _id: "session-1",
                conversationId: "conversation-1",
              },
              turn: {
                _id: "turn-1",
                ordinal: 4,
                prompt: "Add a helper",
                requestId: "request-1",
                agentType: "general",
              },
            },
          ];
        }
        if (query === apiTokens.social.sessions.listFileOpsSince) {
          return [];
        }
        return [];
      });
      convexState.mutationMock.mockImplementation(async (mutation: unknown) => {
        if (mutation === apiTokens.social.sessions.claimTurn) {
          return { claimed: true };
        }
        return {};
      });

      service.setConvexUrl("https://demo.convex.cloud");
      service.setAuthToken("token-1");
      service.start();

      convexState.subscription?.onUpdate([
        {
          session: {
            _id: "session-1",
            hostOwnerId: "owner-1",
            hostDeviceId: "device-1",
            workspaceFolderName: "Host Session",
            conversationId: "conversation-1",
            status: "active",
          },
          membership: {
            ownerId: "owner-1",
          },
        },
      ]);
      await flushMicrotasks();

      await (service as any).runTick();

      expect(runAutomationTurn).toHaveBeenCalledTimes(1);
      expect(appendEvent).toHaveBeenCalledTimes(1);
      expect(onLocalChatUpdated).toHaveBeenCalledTimes(1);
      expect(convexState.mutationMock).toHaveBeenCalledWith(
        apiTokens.social.sessions[expectedMutation],
        expect.objectContaining({
          sessionId: "session-1",
          turnId: "turn-1",
          deviceId: "device-1",
        }),
      );
      expect(store.getSession("session-1")?.lastObservedTurnOrdinal ?? 0).toBe(0);

      service.stop();
    },
  );
});
