import { describe, expect, it } from "vitest";
import { createRemoteTurnBridge } from "../../../../../runtime/kernel/remote-turn-bridge.js";
import {
  getConvexErrorCode,
  getConvexErrorMessage,
  isConvexDeviceKeyMismatchError,
  isConvexUnauthenticatedError,
  shouldStopRemoteTurnForAuthFailure,
} from "../../../../../runtime/kernel/runner.js";

describe("remote-turn auth failure handling", () => {
  it("detects Convex unauthenticated errors from nested error data", () => {
    const error = {
      data: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      },
    };

    expect(getConvexErrorCode(error)).toBe("UNAUTHENTICATED");
    expect(isConvexUnauthenticatedError(error)).toBe(true);
  });

  it("detects device key mismatch errors from nested Convex error data", () => {
    const error = {
      data: {
        code: "UNAUTHORIZED",
        message: "Device key mismatch for this machine.",
      },
    };

    expect(getConvexErrorCode(error)).toBe("UNAUTHORIZED");
    expect(getConvexErrorMessage(error)).toBe(
      "Device key mismatch for this machine.",
    );
    expect(isConvexDeviceKeyMismatchError(error)).toBe(true);
  });

  it("ignores the first two unauthenticated failures inside the auth grace window", () => {
    const authWindowStartedAt = 1_000;
    const nowMs = authWindowStartedAt + 5_000;

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt,
        failureCount: 1,
        nowMs,
      }),
    ).toBe(false);

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt,
        failureCount: 2,
        nowMs,
      }),
    ).toBe(false);
  });

  it("stops remote-turn sync after repeated or late unauthenticated failures", () => {
    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: 1_000,
        failureCount: 3,
        nowMs: 6_000,
      }),
    ).toBe(true);

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: 1_000,
        failureCount: 1,
        nowMs: 17_000,
      }),
    ).toBe(true);
  });
});

describe("remote-turn mobile model override", () => {
  it("passes the mobile-selected model into the local automation turn", async () => {
    let onUpdate:
      | ((events: Array<{
          _id: string;
          timestamp: number;
          type: string;
          requestId?: string;
          payload?: Record<string, unknown>;
        }>) => void)
      | null = null;
    let capturedModelOverride: string | undefined;
    let completed = false;

    const bridge = createRemoteTurnBridge({
      deviceId: "desktop-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
        onUpdate = nextOnUpdate;
        return () => {};
      },
      claimRemoteTurn: async () => {},
      runLocalTurn: async ({ modelOverride }) => {
        capturedModelOverride = modelOverride;
        return { status: "ok", finalText: "done" };
      },
      completeConnectorTurn: async () => {
        completed = true;
      },
    });

    bridge.start();
    onUpdate?.([
      {
        _id: "event-1",
        timestamp: Date.now(),
        type: "remote_turn_request",
        requestId: "request-1",
        payload: {
          conversationId: "conversation-1",
          text: "Use the model I picked on my phone.",
          provider: "stella_app",
          deliveryMeta: { mobileModel: "stella/designer" },
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedModelOverride).toBe("stella/designer");
    expect(completed).toBe(true);
    bridge.stop();
  });

  it("uses transient audio transcripts as the local turn prompt", async () => {
    let onUpdate:
      | ((events: Array<{
          _id: string;
          timestamp: number;
          type: string;
          requestId?: string;
          payload?: Record<string, unknown>;
        }>) => void)
      | null = null;
    let capturedPrompt = "";

    const bridge = createRemoteTurnBridge({
      deviceId: "desktop-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
        onUpdate = nextOnUpdate;
        return () => {};
      },
      claimRemoteTurn: async () => {},
      runLocalTurn: async ({ userPrompt }) => {
        capturedPrompt = userPrompt;
        return { status: "ok", finalText: "done" };
      },
      completeConnectorTurn: async () => {},
    });

    bridge.start();
    onUpdate?.([
      {
        _id: "event-1",
        timestamp: Date.now(),
        type: "remote_turn_request",
        requestId: "request-1",
        payload: {
          conversationId: "conversation-1",
          text: "[Audio]",
          provider: "linq",
          deliveryMeta: {},
          mediaRefs: [
            {
              url: "https://example.test/audio.m4a",
              kind: "audio",
              mimeType: "audio/mp4",
              transcript: "Please bring coffee on your way home.",
            },
          ],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedPrompt).toBe(
      "Voice message transcript:\nPlease bring coffee on your way home.",
    );
    bridge.stop();
  });

  it("adds transient extracted file text to the local turn prompt", async () => {
    let onUpdate:
      | ((events: Array<{
          _id: string;
          timestamp: number;
          type: string;
          requestId?: string;
          payload?: Record<string, unknown>;
        }>) => void)
      | null = null;
    let capturedPrompt = "";

    const bridge = createRemoteTurnBridge({
      deviceId: "desktop-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
        onUpdate = nextOnUpdate;
        return () => {};
      },
      claimRemoteTurn: async () => {},
      runLocalTurn: async ({ userPrompt }) => {
        capturedPrompt = userPrompt;
        return { status: "ok", finalText: "done" };
      },
      completeConnectorTurn: async () => {},
    });

    bridge.start();
    onUpdate?.([
      {
        _id: "event-1",
        timestamp: Date.now(),
        type: "remote_turn_request",
        requestId: "request-1",
        payload: {
          conversationId: "conversation-1",
          text: "[Attachment]",
          provider: "linq",
          deliveryMeta: {},
          mediaRefs: [
            {
              url: "https://example.test/report.pdf",
              kind: "file",
              mimeType: "application/pdf",
              name: "report.pdf",
              extractedText: "Quarterly revenue was $42.",
            },
          ],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedPrompt).toBe("report.pdf:\nQuarterly revenue was $42.");
    bridge.stop();
  });
});
