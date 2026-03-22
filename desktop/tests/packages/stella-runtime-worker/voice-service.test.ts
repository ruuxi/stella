import { describe, expect, it, vi } from "vitest";
import { VoiceRuntimeService } from "../../../packages/runtime-worker/voice/service.js";

describe("voice runtime service", () => {
  it("rejects startup failures without leaving an unhandled rejection behind", async () => {
    const unhandledRejection = vi.fn();
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const service = new VoiceRuntimeService({
        getRunner: () => ({
          handleLocalChat: vi
            .fn()
            .mockRejectedValue(new Error("Stella runtime is still initializing")),
          appendThreadMessage: vi.fn(),
          webSearch: vi.fn(),
        }),
        emitAgentEvent: vi.fn(),
        emitSelfModHmrState: vi.fn(),
        requestHostHmrTransition: vi.fn(),
      });

      await expect(
        service.orchestratorChat({
          requestId: "req-startup-fail",
          conversationId: "conv-1",
          message: "hello",
        }),
      ).rejects.toThrow("Stella runtime is still initializing");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("propagates self-mod HMR progress through the voice bridge", async () => {
    const emittedStates: Array<{
      requestId: string;
      runId?: string;
      state: {
        phase: "paused" | "applying" | "reloading" | "idle";
        paused: boolean;
        requiresFullReload: boolean;
      };
    }> = [];
    const requestHostHmrTransition = vi.fn().mockResolvedValue(undefined);

    const runner = {
      handleLocalChat: vi.fn((_payload, callbacks) => {
        queueMicrotask(async () => {
          callbacks.onSelfModHmrState?.({
            phase: "paused",
            paused: true,
            requiresFullReload: false,
          });
          await callbacks.onHmrResume?.({
            requiresFullReload: false,
            reportState: (state) => callbacks.onSelfModHmrState?.(state),
            resumeHmr: async () => {},
          });
          callbacks.onEnd({
            runId: "run-1",
            agentType: "orchestrator",
            seq: 1,
            finalText: "done",
            persisted: true,
          });
        });

        return Promise.resolve({ runId: "run-1" });
      }),
      appendThreadMessage: vi.fn(),
      webSearch: vi.fn(),
    };

    const service = new VoiceRuntimeService({
      getRunner: () => runner,
      emitAgentEvent: vi.fn(),
      emitSelfModHmrState: (payload) => {
        emittedStates.push(payload);
      },
      requestHostHmrTransition,
    });

    const result = await service.orchestratorChat({
      requestId: "req-1",
      conversationId: "conv-1",
      message: "hello",
    });

    expect(result).toBe("done");
    expect(requestHostHmrTransition).toHaveBeenCalledWith({
      runId: "run-1",
      requiresFullReload: false,
    });
    expect(
      emittedStates.map(({ requestId, runId, state }) => ({
        requestId,
        runId,
        state,
      })),
    ).toEqual([
      {
        requestId: "req-1",
        runId: undefined,
        state: {
          phase: "paused",
          paused: true,
          requiresFullReload: false,
        },
      },
      {
        requestId: "req-1",
        runId: "run-1",
        state: {
          phase: "applying",
          paused: false,
          requiresFullReload: false,
        },
      },
      {
        requestId: "req-1",
        runId: "run-1",
        state: {
          phase: "idle",
          paused: false,
          requiresFullReload: false,
        },
      },
    ]);
  });
});
