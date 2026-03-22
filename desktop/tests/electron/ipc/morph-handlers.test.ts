import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcEvents = new EventEmitter();
const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcEvents.on(channel, handler);
    }),
    removeListener: vi.fn(
      (channel: string, handler: (...args: unknown[]) => void) => {
        ipcEvents.removeListener(channel, handler);
      },
    ),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
  },
}));

const { registerMorphHandlers } = await import(
  "../../../electron/ipc/morph-handlers.js"
);

describe("registerMorphHandlers", () => {
  beforeEach(() => {
    ipcEvents.removeAllListeners();
    ipcHandleHandlers.clear();
  });

  it("ignores stale overlay ready/done signals from other morph transitions", async () => {
    const capturePage = vi
      .fn()
      .mockResolvedValue({ toDataURL: () => "data:image/png;base64,test" });
    const fullWindow = {
      isDestroyed: () => false,
      getBounds: () => ({ x: 10, y: 20, width: 640, height: 480 }),
      webContents: {
        capturePage,
      },
    };

    let activeTransitionId: string | null = null;
    const overlay = {
      getActiveMorphTransitionId: vi.fn(() => activeTransitionId),
      startMorphForward: vi.fn((transitionId: string) => {
        activeTransitionId = transitionId;
      }),
      startMorphReverse: vi.fn((transitionId: string) => {
        return activeTransitionId === transitionId;
      }),
      endMorph: vi.fn((transitionId: string) => {
        if (activeTransitionId !== transitionId) {
          return false;
        }
        activeTransitionId = null;
        return true;
      }),
    };

    registerMorphHandlers({
      windowManager: {
        getFullWindow: () => fullWindow,
      } as never,
      getOverlayController: () => overlay as never,
    });

    const startHandler = ipcHandleHandlers.get("morph:start");
    const completeHandler = ipcHandleHandlers.get("morph:complete");
    expect(startHandler).toBeTypeOf("function");
    expect(completeHandler).toBeTypeOf("function");

    let startResolved = false;
    const startPromise = Promise.resolve(startHandler?.()).then((result) => {
      startResolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay.startMorphForward).toHaveBeenCalledOnce();
    const transitionId = overlay.startMorphForward.mock.calls[0]?.[0];
    expect(typeof transitionId).toBe("string");

    ipcEvents.emit("overlay:morphReady", {}, { transitionId: "stale-transition" });
    await Promise.resolve();
    expect(startResolved).toBe(false);

    ipcEvents.emit("overlay:morphReady", {}, { transitionId });
    await expect(startPromise).resolves.toEqual({ ok: true });

    let completeResolved = false;
    const completePromise = Promise.resolve(completeHandler?.()).then((result) => {
      completeResolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay.startMorphReverse).toHaveBeenCalledOnce();
    expect(overlay.startMorphReverse).toHaveBeenCalledWith(
      transitionId,
      "data:image/png;base64,test",
      false,
    );

    ipcEvents.emit("overlay:morphDone", {}, { transitionId: "stale-transition" });
    await Promise.resolve();
    expect(completeResolved).toBe(false);

    ipcEvents.emit("overlay:morphDone", {}, { transitionId });
    await expect(completePromise).resolves.toEqual({ ok: true });
    expect(overlay.endMorph).toHaveBeenCalledWith(transitionId);
  });
});
