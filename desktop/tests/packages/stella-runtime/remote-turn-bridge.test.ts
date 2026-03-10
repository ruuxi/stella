import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteTurnBridge, type RemoteTurnRequestEvent } from "../../../electron/core/runtime/remote-turn-bridge.js";

describe("createRemoteTurnBridge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeConnectorRequest = (): RemoteTurnRequestEvent => ({
    _id: "event-1",
    timestamp: 1_000,
    type: "remote_turn_request",
    requestId: "request-1",
    payload: {
      conversationId: "conversation-1",
      text: "hello from telegram",
      provider: "telegram",
    },
  });

  const requireEmit = (
    emitUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null,
  ): ((events: RemoteTurnRequestEvent[]) => void) => {
    if (!emitUpdate) {
      throw new Error("Missing subscription callback");
    }
    return emitUpdate;
  };

  it("runs local connector turns from subscription updates and completes them through Convex", async () => {
    let emitUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const subscribeRemoteTurnRequests = vi.fn(({ onUpdate }: { onUpdate: (events: RemoteTurnRequestEvent[]) => void }) => {
      emitUpdate = onUpdate;
      return () => {
        emitUpdate = null;
      };
    });
    const runLocalTurn = vi.fn().mockResolvedValue({
      status: "ok",
      finalText: "local reply",
    });
    const completeConnectorTurn = vi.fn().mockResolvedValue(undefined);

    const bridge = createRemoteTurnBridge({
      deviceId: "device-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests,
      runLocalTurn,
      completeConnectorTurn,
    });

    bridge.start();
    requireEmit(emitUpdate)([makeConnectorRequest()]);
    await Promise.resolve();
    await Promise.resolve();
    bridge.stop();

    expect(subscribeRemoteTurnRequests).toHaveBeenCalledWith({
      deviceId: "device-1",
      since: expect.any(Number),
      onUpdate: expect.any(Function),
      onError: expect.any(Function),
    });
    expect(runLocalTurn).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      userPrompt: "hello from telegram",
      agentType: undefined,
    });
    expect(completeConnectorTurn).toHaveBeenCalledWith({
      requestId: "request-1",
      conversationId: "conversation-1",
      text: "local reply",
    });
  });

  it("keeps busy connector turns pending and retries them later", async () => {
    vi.useFakeTimers();

    let emitUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const subscribeRemoteTurnRequests = vi.fn(({ onUpdate }: { onUpdate: (events: RemoteTurnRequestEvent[]) => void }) => {
      emitUpdate = onUpdate;
      return () => {
        emitUpdate = null;
      };
    });
    const runLocalTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: "busy",
        finalText: "",
        error: "runner busy",
      })
      .mockResolvedValueOnce({
        status: "ok",
        finalText: "done",
      });
    const completeConnectorTurn = vi.fn().mockResolvedValue(undefined);

    const bridge = createRemoteTurnBridge({
      deviceId: "device-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests,
      runLocalTurn,
      completeConnectorTurn,
    });

    bridge.start();
    requireEmit(emitUpdate)([makeConnectorRequest()]);
    await Promise.resolve();
    expect(bridge.getPendingRequestIds()).toEqual(["request-1"]);
    expect(completeConnectorTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_100);
    await Promise.resolve();
    bridge.stop();

    expect(runLocalTurn).toHaveBeenCalledTimes(2);
    expect(completeConnectorTurn).toHaveBeenCalledWith({
      requestId: "request-1",
      conversationId: "conversation-1",
      text: "done",
    });
  });

  it("drops pending connector turns when the subscription no longer includes them", async () => {
    let emitUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const subscribeRemoteTurnRequests = vi.fn(({ onUpdate }: { onUpdate: (events: RemoteTurnRequestEvent[]) => void }) => {
      emitUpdate = onUpdate;
      return () => {
        emitUpdate = null;
      };
    });

    const bridge = createRemoteTurnBridge({
      deviceId: "device-1",
      isEnabled: () => true,
      isRunnerBusy: () => true,
      subscribeRemoteTurnRequests,
      runLocalTurn: vi.fn(),
      completeConnectorTurn: vi.fn(),
    });

    bridge.start();
    requireEmit(emitUpdate)([makeConnectorRequest()]);
    expect(bridge.getPendingRequestIds()).toEqual(["request-1"]);

    requireEmit(emitUpdate)([]);
    expect(bridge.getPendingRequestIds()).toEqual([]);

    bridge.stop();
  });
});
