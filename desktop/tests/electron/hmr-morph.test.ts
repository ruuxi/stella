import { describe, expect, it, vi } from "vitest";
import { createHmrTransitionController } from "../../electron/self-mod/hmr-morph.ts";

describe("createHmrTransitionController", () => {
  it("falls back cleanly when the overlay surface is not ready yet", async () => {
    const capturePage = vi.fn();
    const fullWindow = {
      isDestroyed: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      webContents: {
        capturePage,
      },
    } as never;

    const startMorphForward = vi.fn();
    const resumeHmr = vi.fn(async () => {});
    const reportState = vi.fn();

    const controller = createHmrTransitionController({
      getFullWindow: () => fullWindow,
      getOverlayController: () =>
        ({
          ensureReadyForMorph: vi.fn(async () => false),
          startMorphForward,
        }) as never,
    });

    await controller.runTransition({
      runId: "run-1",
      resumeHmr,
      reportState,
      requiresFullReload: false,
    });

    expect(resumeHmr).toHaveBeenCalledTimes(1);
    expect(startMorphForward).not.toHaveBeenCalled();
    expect(capturePage).not.toHaveBeenCalled();
  });
});
