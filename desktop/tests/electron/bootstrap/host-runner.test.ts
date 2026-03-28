import { describe, expect, it, vi } from "vitest";
import {
  buildHostRunnerUiActScript,
  createHostRunnerHandlers,
} from "../../../electron/bootstrap/host-runner.js";

describe("host runner bootstrap helpers", () => {
  it("builds the UI command script for supported actions", () => {
    expect(
      buildHostRunnerUiActScript({ action: "click", ref: "button:submit" }),
    ).toContain(`handleCommand("click", ["button:submit"])`);

    expect(
      buildHostRunnerUiActScript({
        action: "fill",
        ref: "input:email",
        value: "user@example.com",
      }),
    ).toContain(`handleCommand("fill", ["input:email", "user@example.com"])`);

    expect(
      buildHostRunnerUiActScript({
        action: "select",
        ref: "select:country",
        value: "US",
      }),
    ).toContain(`handleCommand("select", ["select:country", "US"])`);
  });

  it("falls back to direct HMR resume when no transition controller exists", async () => {
    const reportState = vi.fn();
    const resumeHmr = vi.fn(async () => undefined);

    const handlers = createHostRunnerHandlers(
      {
        services: {
          credentialService: { requestCredential: vi.fn() },
          externalLinkService: { openSafeExternalUrl: vi.fn() },
        },
        state: {
          hmrTransitionController: null,
          windowManager: null,
        },
      } as never,
      {
        loadDeviceIdentity: async () =>
          ({ deviceId: "device-1", publicKey: "pub-1" }) as never,
      },
    );

    await handlers.runHmrTransition?.({
      runId: "run-1",
      requiresFullReload: false,
      reportState,
      resumeHmr,
    });

    expect(reportState).toHaveBeenNthCalledWith(1, {
      phase: "applying",
      paused: false,
      requiresFullReload: false,
    });
    expect(resumeHmr).toHaveBeenCalledTimes(1);
    expect(reportState).toHaveBeenNthCalledWith(2, {
      phase: "idle",
      paused: false,
      requiresFullReload: false,
    });
  });
});
