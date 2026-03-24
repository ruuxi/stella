import { beforeEach, describe, expect, it, vi } from "vitest";

const onHandlers = new Map<string, Set<(payload: unknown) => void>>();
const mockClient = {
  on: vi.fn((event: string, listener: (payload: unknown) => void) => {
    const set = onHandlers.get(event) ?? new Set();
    set.add(listener);
    onHandlers.set(event, set);
    return () => {
      set.delete(listener);
    };
  }),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  configure: vi.fn(async () => ({ ok: true })),
  health: vi.fn(async () => ({
    ready: false,
    daemonPid: 1,
    workerPid: 2,
    workerGeneration: 1,
    deviceId: "device-1",
    activeRunId: null,
    activeTaskCount: 0,
  })),
  healthCheck: vi.fn(async () => ({ ready: true })),
  getActiveRun: vi.fn(async () => null),
  startChat: vi.fn(async () => ({ runId: "run-root" })),
  resumeRunEvents: vi.fn(async () => ({
    events: [
      {
        type: "task-started",
        runId: "run-root",
        seq: 1,
        taskId: "task-1",
        agentType: "general",
        description: "Investigate",
      },
    ],
    exhausted: false,
  })),
  cancelChat: vi.fn(async () => ({ ok: true })),
};

const StellaRuntimeClientMock = vi.fn(function MockStellaRuntimeClient() {
  return mockClient;
});

vi.mock("../../packages/runtime-client/index.js", () => ({
  StellaRuntimeClient: StellaRuntimeClientMock,
}));

const { RuntimeClientAdapter } = await import(
  "../../electron/runtime-client-adapter.js"
);

describe("RuntimeClientAdapter", () => {
  beforeEach(() => {
    onHandlers.clear();
    for (const fn of Object.values(mockClient)) {
      if ("mockClear" in fn && typeof fn.mockClear === "function") {
        fn.mockClear();
      }
    }
    mockClient.on.mockImplementation((event: string, listener: (payload: unknown) => void) => {
      const set = onHandlers.get(event) ?? new Set();
      set.add(listener);
      onHandlers.set(event, set);
      return () => {
        set.delete(listener);
      };
    });
    mockClient.start.mockResolvedValue(undefined);
    mockClient.stop.mockResolvedValue(undefined);
    mockClient.configure.mockResolvedValue({ ok: true });
    mockClient.health.mockResolvedValue({
      ready: false,
      daemonPid: 1,
      workerPid: 2,
      workerGeneration: 1,
      deviceId: "device-1",
      activeRunId: null,
      activeTaskCount: 0,
    });
    mockClient.healthCheck.mockResolvedValue({ ready: true });
    mockClient.getActiveRun.mockResolvedValue(null);
    mockClient.startChat.mockResolvedValue({ runId: "run-root" });
    mockClient.resumeRunEvents.mockResolvedValue({
      events: [
        {
          type: "task-started",
          runId: "run-root",
          seq: 1,
          taskId: "task-1",
          agentType: "general",
          description: "Investigate",
        },
      ],
      exhausted: false,
    });
    mockClient.cancelChat.mockResolvedValue({ ok: true });
  });

  it("preserves the root run id when translating task lifecycle events", async () => {
    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    const onTaskEvent = vi.fn();

    await adapter.handleLocalChat(
      {
        conversationId: "conv-1",
        userMessageId: "msg-1",
        userPrompt: "hello",
      },
      {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onTaskEvent,
      },
    );

    expect(onTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        rootRunId: "run-root",
        taskId: "task-1",
      }),
    );
  });

  it("does not drop task lifecycle events when their seq overlaps with run events", async () => {
    mockClient.resumeRunEvents.mockResolvedValue({
      events: [
        {
          type: "stream",
          runId: "run-root",
          seq: 1,
          chunk: "hello",
        },
        {
          type: "task-started",
          runId: "run-root",
          seq: 1,
          taskId: "task-1",
          agentType: "general",
          description: "Investigate",
        },
      ],
      exhausted: false,
    });

    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    const onStream = vi.fn();
    const onTaskEvent = vi.fn();

    await adapter.handleLocalChat(
      {
        conversationId: "conv-1",
        userMessageId: "msg-1",
        userPrompt: "hello",
      },
      {
        onStream,
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onTaskEvent,
      },
    );

    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 1, chunk: "hello" }),
    );
    expect(onTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ rootRunId: "run-root", taskId: "task-1" }),
    );
  });

  it("keeps listening for background task completion after the parent run ends", async () => {
    mockClient.resumeRunEvents.mockResolvedValue({
      events: [
        {
          type: "task-started",
          runId: "run-root",
          seq: 1,
          taskId: "task-1",
          agentType: "app",
          description: "Open Wikipedia in browser",
        },
      ],
      exhausted: false,
    });

    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    const onEnd = vi.fn();
    const onTaskEvent = vi.fn();
    const baselineRunListenerCount = onHandlers.get("run-event")?.size ?? 0;

    await adapter.handleLocalChat(
      {
        conversationId: "conv-1",
        userMessageId: "msg-1",
        userPrompt: "open wikipedia",
      },
      {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd,
        onTaskEvent,
      },
    );

    expect(onHandlers.get("run-event")?.size).toBe(baselineRunListenerCount + 1);

    onHandlers.get("run-event")?.forEach((listener) => {
      listener({
        type: "end",
        runId: "run-root",
        seq: 2,
      });
    });

    expect(onEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "end",
        runId: "run-root",
        seq: 2,
      }),
    );
    expect(onHandlers.get("run-event")?.size).toBe(baselineRunListenerCount + 1);

    onHandlers.get("run-event")?.forEach((listener) => {
      listener({
        type: "task-completed",
        runId: "run-root",
        seq: 2,
        taskId: "task-1",
        agentType: "app",
        result: "Opened wikipedia.org",
      });
    });

    expect(onTaskEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "task-completed",
        rootRunId: "run-root",
        taskId: "task-1",
        agentType: "app",
        result: "Opened wikipedia.org",
      }),
    );
    expect(onHandlers.get("run-event")?.size).toBe(baselineRunListenerCount);
  });

  it("swallows health-check connection failures and reports not ready", async () => {
    mockClient.healthCheck.mockRejectedValueOnce(
      new Error("Stella runtime client is not connected."),
    );

    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    await expect(adapter.agentHealthCheck()).resolves.toEqual({
      ready: false,
      reason: "Stella runtime client is not connected.",
    });
  });

  it("awaits the latest active run snapshot instead of returning a stale cached value", async () => {
    mockClient.getActiveRun.mockResolvedValueOnce({
      runId: "run-fresh",
      conversationId: "conv-fresh",
    });

    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    await expect(adapter.getActiveOrchestratorRun()).resolves.toEqual({
      runId: "run-fresh",
      conversationId: "conv-fresh",
    });
  });

  it("waits for the connected event instead of polling runtime health", async () => {
    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    const waiting = adapter.waitUntilConnected(1_000);
    onHandlers.get("runtime-connected")?.forEach((listener) => {
      listener(undefined);
    });

    await expect(waiting).resolves.toBeUndefined();
    expect(mockClient.health).not.toHaveBeenCalled();
  });

  it("waits for a ready notification instead of tight-loop polling health checks", async () => {
    mockClient.healthCheck.mockResolvedValueOnce({ ready: false });

    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    const waiting = adapter.waitUntilReady(1_000);
    setTimeout(() => {
      onHandlers.get("runtime-ready")?.forEach((listener) => {
        listener({
          ready: true,
          daemonPid: 1,
          workerPid: 2,
          workerGeneration: 1,
          deviceId: "device-1",
          activeRunId: null,
          activeTaskCount: 0,
        });
      });
    }, 0);

    await expect(waiting).resolves.toBeUndefined();
    expect(mockClient.healthCheck).toHaveBeenCalledTimes(1);
  });

  it("queues config patches before start and replays them once the runtime starts", async () => {
    const adapter = new RuntimeClientAdapter({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: true,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    adapter.setConvexUrl("https://convex.example");
    adapter.setAuthToken("token-123");

    expect(mockClient.configure).not.toHaveBeenCalled();

    await adapter.start();

    expect(mockClient.configure).toHaveBeenCalledTimes(1);
    expect(mockClient.configure).toHaveBeenCalledWith({
      convexUrl: "https://convex.example",
      authToken: "token-123",
    });
  });

  it("logs configure failures after start instead of silently swallowing them", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockClient.configure.mockRejectedValueOnce(new Error("configure failed"));

    try {
      const adapter = new RuntimeClientAdapter({
        initializeParams: {
          clientName: "test",
          clientVersion: "0.0.0",
          isDev: true,
          platform: "win32",
          frontendRoot: "/mock/frontend",
          stellaHomePath: "/mock/home/.stella",
          stellaWorkspacePath: "/mock/home/.stella/workspace",
        },
        hostHandlers: {
          uiSnapshot: async () => "",
          uiAct: async () => "",
          getDeviceIdentity: async () => ({
            deviceId: "device-1",
            publicKey: "public-key",
          }),
          signHeartbeatPayload: async () => ({
            publicKey: "public-key",
            signature: "signature",
          }),
          requestCredential: async () => ({
            secretId: "secret",
            provider: "provider",
            label: "label",
          }),
          displayUpdate: async () => {},
        },
      });

      await adapter.start();
      adapter.setConvexSiteUrl("https://site.example");
      await Promise.resolve();

      expect(mockClient.configure).toHaveBeenCalledWith({
        convexSiteUrl: "https://site.example",
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[stella-runtime-adapter] Failed to apply runtime config patch:",
        expect.objectContaining({
          patch: { convexSiteUrl: "https://site.example" },
          error: "configure failed",
        }),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
