import { describe, expect, it, vi } from "vitest";
import { AGENT_STREAM_EVENT_TYPES } from "../../../runtime/contracts/agent-runtime.js";
import { shouldAckWorkerRunEvent } from "../../../runtime/host/index.js";
import { RuntimeHostAdapter } from "../../electron/runtime-host-adapter.js";

const createAdapter = () =>
  new RuntimeHostAdapter({
    hostHandlers: {
      getDeviceIdentity: async () => ({
        deviceId: "dev-device",
        publicKey: "pub",
      }),
      signHeartbeatPayload: async () => ({
        publicKey: "pub",
        signature: "sig",
      }),
      requestCredential: async () => ({
        secretId: "secret",
        provider: "test",
        label: "Test",
      }),
      displayUpdate: () => undefined,
    },
    initializeParams: {
      clientName: "test-client",
      clientVersion: "0.0.0",
      isDev: false,
      platform: process.platform,
      stellaAppDir: "/tmp/stella-test",
      stellaWorkspacePath: "/tmp/stella-test",
    },
  });

describe("RuntimeHostAdapter config batching", () => {
  it("batches same-tick auth patches into one configure call", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.started = true;
    const configure = vi.fn().mockResolvedValue({ ok: true });
    anyAdapter.host.configure = configure;

    adapter.setHasConnectedAccount(true);
    adapter.setAuthToken("fresh-token");

    await Promise.resolve();

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith({
      hasConnectedAccount: true,
      authToken: "fresh-token",
    });
  });

  it("does not mark a completed startChat result as the active run", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.host.startChat = vi.fn().mockResolvedValue({ runId: "run-1" });

    await adapter.handleLocalChat(
      {
        conversationId: "conversation-1",
        userPrompt: "hello",
      },
      {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
      },
    );

    expect(anyAdapter.activeRun).toBeNull();
  });
});

describe("worker run-event acks", () => {
  it("keeps replay-critical terminal and synthetic events in the worker log", () => {
    expect(
      shouldAckWorkerRunEvent({
        type: AGENT_STREAM_EVENT_TYPES.STREAM,
        seq: 42,
      }),
    ).toBe(true);
    expect(
      shouldAckWorkerRunEvent({
        type: AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
        seq: Date.now(),
      }),
    ).toBe(false);
    expect(
      shouldAckWorkerRunEvent({
        type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
        seq: 43,
      }),
    ).toBe(false);
  });
});

describe("RuntimeHostAdapter resumed chat sessions", () => {
  const emitRunEvent = (
    adapter: ReturnType<typeof createAdapter>,
    event: Record<string, unknown>,
  ) => {
    (
      adapter.host as unknown as {
        events: { emit: (name: string, event: unknown) => void };
      }
    ).events.emit("run-event", event);
  };

  const createCallbacks = () => ({
    onRunFinished: vi.fn(),
    onStream: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
  });

  it("routes resumed run events by conversation and run when the old request session is gone", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        active: true,
      },
      callbacks,
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.STREAM,
      runId: "run-1",
      seq: 1,
      conversationId: "conversation-1",
      chunk: "still ",
    });

    expect(callbacks.onStream).toHaveBeenCalledTimes(1);
    expect(callbacks.onStream).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "still " }),
    );
  });

  it("does not double-dispatch when a resumed event still carries the original request id", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        requestId: "request-1",
        active: true,
      },
      callbacks,
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.STREAM,
      runId: "run-1",
      seq: 1,
      conversationId: "conversation-1",
      requestId: "request-1",
      chunk: "live",
    });

    expect(callbacks.onStream).toHaveBeenCalledTimes(1);
  });

  it("streams a visible follow-up run that reuses the preserved request id", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();
    const onRunStarted = vi.fn();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "root-run",
        requestId: "request-1",
        active: true,
      },
      { ...callbacks, onRunStarted },
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
      runId: "follow-up-run",
      seq: 1,
      conversationId: "conversation-1",
      requestId: "request-1",
      userMessageId: "message-1",
    });
    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.STREAM,
      runId: "follow-up-run",
      seq: 2,
      conversationId: "conversation-1",
      requestId: "request-1",
      userMessageId: "message-1",
      chunk: "visible reply",
    });

    expect(onRunStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onStream).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "visible reply" }),
    );
  });
});
