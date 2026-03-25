/**
 * IPC handlers for triggering the WebGL morph transition from the renderer.
 * Used during onboarding to morph between demo previews.
 */

import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import type { WindowManager } from "../windows/window-manager.js";

type MorphHandlersOptions = {
  windowManager: WindowManager;
  getOverlayController: () => OverlayWindowController | null;
};

/** Onboarding IPC only — mirrors overlay wait windows (not imported from HMR `morph-timing`). */
const ONBOARDING_MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
const ONBOARDING_MORPH_DONE_TIMEOUT_MS = 5000;

export const registerMorphHandlers = (options: MorphHandlersOptions) => {
  let activeOnboardingTransitionId: string | null = null;

  const captureWindow = async (win: BrowserWindow): Promise<string | null> => {
    try {
      const image = await win.webContents.capturePage();
      return image.toDataURL();
    } catch {
      return null;
    }
  };

  const waitForSignal = (
    channel: "overlay:morphReady" | "overlay:morphDone",
    transitionId: string,
    timeoutMs: number,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const handler = (
        _event: unknown,
        payload?: { transitionId?: string },
      ) => {
        if (payload?.transitionId !== transitionId) {
          return;
        }
        clearTimeout(timer);
        ipcMain.removeListener(channel, handler);
        resolve(true);
      };
      const timer = setTimeout(() => {
        ipcMain.removeListener(channel, handler);
        resolve(false);
      }, timeoutMs);
      ipcMain.on(channel, handler);
    });
  };

  /**
   * morph:start — Captures the current window, starts the forward morph ripple,
   * and resolves once the overlay is ready (covering the old state).
   */
  ipcMain.handle("morph:start", async () => {
    const fullWindow = options.windowManager.getFullWindow();
    const overlay = options.getOverlayController();
    if (!fullWindow || fullWindow.isDestroyed() || !overlay) {
      return { ok: false };
    }

    const screenshot = await captureWindow(fullWindow);
    if (!screenshot) {
      return { ok: false };
    }

    const bounds = fullWindow.getBounds();
    const transitionId = randomUUID();
    activeOnboardingTransitionId = transitionId;
    const readyPromise = waitForSignal(
      "overlay:morphReady",
      transitionId,
      ONBOARDING_MORPH_OVERLAY_READY_TIMEOUT_MS,
    );
    overlay.startMorphForward(
      transitionId,
      screenshot,
      bounds,
      fullWindow,
      "onboarding",
    );
    const ready = await readyPromise;
    if (!ready || overlay.getActiveMorphTransitionId() !== transitionId) {
      if (activeOnboardingTransitionId === transitionId) {
        activeOnboardingTransitionId = null;
      }
      return { ok: false };
    }

    return { ok: true };
  });

  /**
   * morph:complete — Captures the new window state, crossfades from old to new,
   * and resolves when the morph animation finishes.
   */
  ipcMain.handle("morph:complete", async () => {
    const fullWindow = options.windowManager.getFullWindow();
    const overlay = options.getOverlayController();
    if (!fullWindow || fullWindow.isDestroyed() || !overlay) {
      return { ok: false };
    }

    const transitionId = activeOnboardingTransitionId;
    if (!transitionId || overlay.getActiveMorphTransitionId() !== transitionId) {
      activeOnboardingTransitionId = null;
      return { ok: false };
    }

    const screenshot = await captureWindow(fullWindow);
    if (!screenshot) {
      overlay.endMorph(transitionId);
      activeOnboardingTransitionId = null;
      return { ok: false };
    }

    const donePromise = waitForSignal(
      "overlay:morphDone",
      transitionId,
      ONBOARDING_MORPH_DONE_TIMEOUT_MS,
    );
    const reverseStarted = overlay.startMorphReverse(
      transitionId,
      screenshot,
      false,
    );
    if (!reverseStarted) {
      activeOnboardingTransitionId = null;
      return { ok: false };
    }
    const done = await donePromise;
    overlay.endMorph(transitionId);
    activeOnboardingTransitionId = null;

    return { ok: done };
  });
};
