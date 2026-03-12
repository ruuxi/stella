import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const voiceSessionMocks = vi.hoisted(() => {
  const instances: Array<{
    state: "idle" | "connecting" | "connected" | "error" | "disconnecting";
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    setConversationId: ReturnType<typeof vi.fn>;
    setInputActive: ReturnType<typeof vi.fn>;
  }> = [];
  const connectPlans: Array<Promise<void> | null> = [];
  return {
    instances,
    connectPlans,
  };
});

vi.mock("@/features/voice/services/realtime-voice", () => ({
  RealtimeVoiceSession: class {
    state: "idle" | "connecting" | "connected" | "error" | "disconnecting" =
      "idle";
    readonly connect = vi.fn(async (_conversationId: string) => {
      this.state = "connecting";
      const plan = voiceSessionMocks.connectPlans.shift() ?? null;
      if (plan) {
        await plan;
      }
      this.state = "connected";
    });
    readonly disconnect = vi.fn(async () => {
      this.state = "idle";
    });
    readonly setConversationId = vi.fn();
    readonly setInputActive = vi.fn();
    readonly getAnalyser = vi.fn(() => null);
    readonly getOutputAnalyser = vi.fn(() => null);
    private listeners = new Set<(event: unknown) => void>();

    constructor() {
      voiceSessionMocks.instances.push(this);
    }

    on(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    emit(event: unknown): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  },
}));

import { VoiceSessionManager } from "../../../../../src/features/voice/hooks/use-realtime-voice";

describe("VoiceSessionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    voiceSessionMocks.instances.length = 0;
    voiceSessionMocks.connectPlans.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the current live session until the replacement session connects", async () => {
    const onStateChange = vi.fn();
    const onSpeakingChange = vi.fn();
    const onUserSpeakingChange = vi.fn();
    const appendEvent = vi.fn();
    const conversationIdRef = { current: "conv-1" };
    const inputActiveRef = { current: false };

    const manager = new VoiceSessionManager({
      conversationIdRef,
      inputActiveRef,
      appendEventRef: { current: appendEvent },
      deviceIdRef: { current: null },
      analyserRef: { current: null },
      outputAnalyserRef: { current: null },
      onStateChange,
      onSpeakingChange,
      onUserSpeakingChange,
    });

    manager.start();
    await Promise.resolve();

    const firstSession = voiceSessionMocks.instances[0]!;
    expect(firstSession.connect).toHaveBeenCalledWith("conv-1");
    expect(firstSession.disconnect).not.toHaveBeenCalled();

    const replacementReady = createDeferred<void>();
    voiceSessionMocks.connectPlans.push(replacementReady.promise);
    conversationIdRef.current = "conv-2";
    manager.updateSession("conv-2", false);

    await vi.advanceTimersByTimeAsync(0);

    const secondSession = voiceSessionMocks.instances[1]!;
    expect(secondSession.connect).toHaveBeenCalledWith("conv-2");
    expect(firstSession.disconnect).not.toHaveBeenCalled();

    replacementReady.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSession.setInputActive).toHaveBeenLastCalledWith(false);
    expect(firstSession.disconnect).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenNthCalledWith(1, "connecting");
    expect(onStateChange).toHaveBeenNthCalledWith(2, "connected");
    expect(onStateChange).toHaveBeenLastCalledWith("connected");
    expect(onSpeakingChange).toHaveBeenCalledWith(false);
    expect(onUserSpeakingChange).toHaveBeenCalledWith(false);
  });

  it("keeps the current live session if a replacement connection fails", async () => {
    const onStateChange = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const conversationIdRef = { current: "conv-1" };
    const inputActiveRef = { current: false };

    const manager = new VoiceSessionManager({
      conversationIdRef,
      inputActiveRef,
      appendEventRef: { current: vi.fn() },
      deviceIdRef: { current: null },
      analyserRef: { current: null },
      outputAnalyserRef: { current: null },
      onStateChange,
      onSpeakingChange: vi.fn(),
      onUserSpeakingChange: vi.fn(),
    });

    manager.start();
    await Promise.resolve();

    const firstSession = voiceSessionMocks.instances[0]!;
    const replacementReady = createDeferred<void>();
    voiceSessionMocks.connectPlans.push(replacementReady.promise);
    conversationIdRef.current = "conv-2";
    manager.updateSession("conv-2", false);
    await vi.advanceTimersByTimeAsync(0);

    replacementReady.reject(new Error("replacement failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSession.disconnect).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalledWith("error");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});


