import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronMocks.handle,
    on: electronMocks.on,
  },
  webContents: { fromId: () => null },
}));

const roots = new Set<string>();

type FakeResponse = {
  statusCode: number | null;
  body: string;
  headersSent: boolean;
  writeHead: (status: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: unknown) => void;
};

const createResponse = (): FakeResponse => {
  const response: FakeResponse = {
    statusCode: null,
    body: "",
    headersSent: false,
    writeHead: (status) => {
      response.statusCode = status;
      response.headersSent = true;
    },
    setHeader: () => undefined,
    end: (chunk) => {
      if (chunk !== undefined) response.body = String(chunk);
    },
  };
  return response;
};

const createInvokeRequest = (payload: Record<string, unknown>) => {
  const request = Readable.from([
    Buffer.from(JSON.stringify({ args: [payload] })),
  ]) as Readable & {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  request.url = "/bridge/ipc/agent%3AstartChat";
  request.method = "POST";
  request.headers = {};
  return request;
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("mobile bridge replay end to end", () => {
  it("returns one durable canonical acceptance through repeated bridge invokes", async () => {
    const { startCapturingHandlers } = await import(
      "../../electron/services/mobile-bridge/handler-registry.js"
    );
    const stopCapturing = startCapturingHandlers();
    const [{ registerAgentHandlers }, { LocalChatHistoryService }, { MobileBridgeService }] =
      await Promise.all([
        import("../../electron/ipc/agent-handlers.js"),
        import("../../electron/services/local-chat-history-service.js"),
        import("../../electron/services/mobile-bridge/service.js"),
      ]);

    const root = path.join(
      os.tmpdir(),
      `stella-mobile-bridge-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.add(root);
    const history = new LocalChatHistoryService({ stellaAppDir: root });
    let runtimeStarts = 0;
    const runner = {
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      handleLocalChat: vi.fn().mockImplementation(async (payload, callbacks) => {
        runtimeStarts += 1;
        history.appendEvent({
          conversationId: payload.conversationId,
          eventId: payload.userMessageEventId,
          type: "user_message",
          timestamp: 1_000,
          payload: { text: payload.userPrompt },
        });
        callbacks.onRunStarted?.({
          runId: "run-1",
          userMessageId: payload.userMessageEventId,
        });
        return { runId: "run-1" };
      }),
    };

    registerAgentHandlers({
      getStellaHostRunner: () => runner as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      stellaAppDir: root,
      localChatHistoryService: history,
      assertPrivilegedSender: () => true,
    });
    stopCapturing();

    const bridge = new MobileBridgeService({
      electronDir: path.join(root, "desktop/electron"),
      isDev: false,
      getDevServerUrl: () => "http://127.0.0.1:5173",
    });
    const anyBridge = bridge as any;
    anyBridge.registrationState = "healthy";
    anyBridge.registrationLeaseExpiresAt = Date.now() + 60_000;
    anyBridge.hostAuthToken = "token";
    anyBridge.convexSiteUrl = "https://example.convex.site";
    anyBridge.deviceId = "desktop-device";
    anyBridge.ensureAuthorized = vi.fn().mockResolvedValue({});

    const payload = {
      conversationId: "conversation-1",
      userPrompt: "hello",
      clientRequestId: "mobile:send-1",
      userMessageEventId: "mobile:send-1",
      storageMode: "local",
    };
    const invoke = async () => {
      const response = createResponse();
      await anyBridge.handleRequest(createInvokeRequest(payload), response);
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body).result as Record<string, unknown>;
    };

    const first = await invoke();
    history.close();
    history.reopen();
    const replay = await invoke();

    expect(first).toMatchObject({
      userMessageId: "mobile:send-1",
      accepted: true,
    });
    expect(replay).toEqual({
      ...first,
      deduplicated: true,
    });
    expect(runtimeStarts).toBe(1);
    expect(
      history.syncMessages({ conversationId: "conversation-1" }).messages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
    history.close();
  });
});
