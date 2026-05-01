/**
 * IPC handlers for triggering the WebGL morph transition from the renderer.
 * Used during onboarding to morph between demo previews.
 */

import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow } from "electron";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import type { WindowManager } from "../windows/window-manager.js";
import {
  captureWindowDataUrl,
  waitForOverlayMorphSignal,
} from "../windows/morph-transition-helpers.js";

type MorphRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MorphHandlersOptions = {
  windowManager: WindowManager;
  getOverlayController: () => OverlayWindowController | null;
};

/** Onboarding IPC only — mirrors overlay wait windows (not imported from HMR `morph-timing`). */
const ONBOARDING_MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
const ONBOARDING_MORPH_DONE_TIMEOUT_MS = 5000;

export const registerMorphHandlers = (options: MorphHandlersOptions) => {
  let activeOnboardingTransitionId: string | null = null;
  let activeOnboardingCaptureRect: MorphRect | null = null;

  const normalizeCaptureRect = (
    fullWindow: BrowserWindow,
    rect?: Partial<MorphRect>,
  ): { captureRect: MorphRect | undefined; screenBounds: MorphRect } => {
    const windowBounds = fullWindow.getBounds();
    const { x, y, width, height } = rect ?? {};
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      width <= 0 ||
      height <= 0
    ) {
      return { captureRect: undefined, screenBounds: windowBounds };
    }

    const captureRect = {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };

    return {
      captureRect,
      screenBounds: {
        x: windowBounds.x + captureRect.x,
        y: windowBounds.y + captureRect.y,
        width: captureRect.width,
        height: captureRect.height,
      },
    };
  };

  /**
   * morph:start — Captures the current window, starts the forward morph ripple,
   * and resolves once the overlay is ready (covering the old state).
   */
  ipcMain.handle(
    "morph:start",
    async (_event, payload?: { rect?: MorphRect }) => {
      const fullWindow = options.windowManager.getFullWindow();
      const overlay = options.getOverlayController();
      if (!fullWindow || fullWindow.isDestroyed() || !overlay) {
        return { ok: false };
      }

      const { captureRect, screenBounds } = normalizeCaptureRect(
        fullWindow,
        payload?.rect,
      );
      const screenshot = await captureWindowDataUrl(fullWindow, captureRect);
      if (!screenshot) {
        return { ok: false };
      }

      const transitionId = randomUUID();
      activeOnboardingTransitionId = transitionId;
      activeOnboardingCaptureRect = captureRect ?? null;
      const readyPromise = waitForOverlayMorphSignal(
        "overlay:morphReady",
        transitionId,
        ONBOARDING_MORPH_OVERLAY_READY_TIMEOUT_MS,
      );
      overlay.startMorphForward(
        transitionId,
        screenshot,
        screenBounds,
        captureRect ? null : fullWindow,
        "onboarding",
      );
      const ready = await readyPromise;
      if (!ready || overlay.getActiveMorphTransitionId() !== transitionId) {
        if (activeOnboardingTransitionId === transitionId) {
          activeOnboardingTransitionId = null;
          activeOnboardingCaptureRect = null;
        }
        return { ok: false };
      }

      return { ok: true };
    },
  );

  /**
   * morph:complete — Captures the new window state, crossfades from old to new,
   * and resolves when the morph animation finishes.
   */
  ipcMain.handle(
    "morph:complete",
    async (_event, payload?: { rect?: MorphRect }) => {
      const fullWindow = options.windowManager.getFullWindow();
      const overlay = options.getOverlayController();
      if (!fullWindow || fullWindow.isDestroyed() || !overlay) {
        return { ok: false };
      }

      const transitionId = activeOnboardingTransitionId;
      if (
        !transitionId ||
        overlay.getActiveMorphTransitionId() !== transitionId
      ) {
        activeOnboardingTransitionId = null;
        activeOnboardingCaptureRect = null;
        return { ok: false };
      }

      const { captureRect } = normalizeCaptureRect(
        fullWindow,
        payload?.rect ?? activeOnboardingCaptureRect ?? undefined,
      );
      const screenshot = await captureWindowDataUrl(fullWindow, captureRect);
      if (!screenshot) {
        overlay.endMorph(transitionId);
        activeOnboardingTransitionId = null;
        activeOnboardingCaptureRect = null;
        return { ok: false };
      }

      const donePromise = waitForOverlayMorphSignal(
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
        activeOnboardingCaptureRect = null;
        return { ok: false };
      }
      const done = await donePromise;
      overlay.endMorph(transitionId);
      activeOnboardingTransitionId = null;
      activeOnboardingCaptureRect = null;

      return { ok: done };
    },
  );
};
