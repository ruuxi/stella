import { screen } from "electron";
import { RADIAL_SIZE } from "../layout-constants.js";
import {
  MouseHookManager,
  type LeftMouseUpEvent,
} from "../input/mouse-hook.js";
import { calculateSelectedWedge, type RadialWedge } from "../radial-wedge.js";
import type { ChatContext } from "../../../runtime/contracts/index.js";
import type { RadialTriggerCode } from "../../src/shared/lib/radial-trigger.js";
import type { MiniDoubleTapModifier } from "../../src/shared/lib/mini-double-tap.js";

const RADIAL_CONTEXT_CAPTURE_DELAY_MS = 180;

export type RadialCaptureBridge = {
  cancelRadialContextCapture: () => void;
  getChatContextSnapshot: () => ChatContext | null;
  setPendingChatContext: (ctx: ChatContext | null) => void;
  clearTransientContext: () => void;
  setRadialContextShouldCommit: (commit: boolean) => void;
  setRadialWindowContextEnabled: (enabled: boolean) => void;
  commitStagedRadialContext: (before: ChatContext | null) => void;
  hasPendingRadialCapture: () => boolean;
  captureRadialContext: (
    x: number,
    y: number,
    before: ChatContext | null,
  ) => void;
  startRegionCapture: () => Promise<{
    screenshot: { dataUrl: string; width: number; height: number } | null;
    window: ChatContext["window"];
  } | null>;
  emptyContext: () => ChatContext;
  broadcastChatContext: () => void;
};

export type RadialOverlayBridge = {
  showRadial: (options?: {
    compactFocused?: boolean;
    miniAlwaysOnTop?: boolean;
  }) => void;
  hideRadial: () => void;
  updateRadialCursor: (x: number, y: number) => void;
  getRadialBounds: () => { x: number; y: number } | null;
};

export type RadialWindowBridge = {
  isCompactMode: () => boolean;
  getLastActiveWindowMode: () => "full" | "mini";
  getLastFocusedWindowMode: () => "full" | "mini";
  isMiniShowing: () => boolean;
  isMiniAlwaysOnTop: () => boolean;
  isWindowFocused: () => boolean;
  showWindow: (target: "full" | "mini") => void;
  minimizeWindow: () => void;
};

type RadialGestureDeps = {
  getRadialTriggerKey: () => RadialTriggerCode;
  getMiniDoubleTapModifier: () => MiniDoubleTapModifier;
  shouldEnable: () => boolean;
  capture: RadialCaptureBridge;
  overlay: RadialOverlayBridge;
  window: RadialWindowBridge;
  /** Single "go to voice now" handler — opens the floating pet and
   *  toggles the realtime voice session. The radial dial's voice
   *  wedge routes through this so its behaviour is identical to the
   *  global keybind and the pet's own mic action button. */
  togglePetVoice: () => void;
  updateUiState: (partial: Record<string, unknown>) => void;
  /**
   * Optional handler for global left-mouse-up events. Wired through the
   * same uIOhook lifecycle so the selection watcher doesn't have to start
   * a second hook (which would clash with this one).
   */
  onLeftMouseUp?: (event: LeftMouseUpEvent) => void;
};

export type DictationPushToTalkHandlers = {
  isEnabled: () => boolean;
  start: () => void;
  stop: (durationMs: number) => void;
  cancel: () => void;
  discard: () => void;
};

export class RadialGestureService {
  private mouseHook: MouseHookManager | null = null;
  private selectionCommitted = false;
  private startedInCompactMode = false;
  private contextBeforeGesture: ChatContext | null = null;
  private radialTriggerKey: RadialTriggerCode;
  private miniDoubleTapModifier: MiniDoubleTapModifier;
  private readonly deps: RadialGestureDeps;
  private scheduledRadialCaptureTimer: ReturnType<typeof setTimeout> | null =
    null;
  private dictationPushToTalkHandlers: DictationPushToTalkHandlers | null =
    null;

  constructor(deps: RadialGestureDeps) {
    this.deps = deps;
    this.radialTriggerKey = deps.getRadialTriggerKey();
    this.miniDoubleTapModifier = deps.getMiniDoubleTapModifier();
  }

  private clearScheduledRadialCapture() {
    if (this.scheduledRadialCaptureTimer) {
      clearTimeout(this.scheduledRadialCaptureTimer);
      this.scheduledRadialCaptureTimer = null;
    }
  }

  private scheduleRadialContextCapture(point: { x: number; y: number }) {
    this.clearScheduledRadialCapture();
    this.scheduledRadialCaptureTimer = setTimeout(() => {
      this.scheduledRadialCaptureTimer = null;
      this.deps.capture.captureRadialContext(
        point.x,
        point.y,
        this.contextBeforeGesture,
      );
    }, RADIAL_CONTEXT_CAPTURE_DELAY_MS);
  }

  private restoreOrClearTransientContext() {
    const { capture } = this.deps;
    const pendingChatContext = capture.getChatContextSnapshot();
    if (this.startedInCompactMode) {
      if (pendingChatContext !== this.contextBeforeGesture) {
        capture.setPendingChatContext(this.contextBeforeGesture);
      }
      return;
    }
    if (pendingChatContext !== null) {
      capture.clearTransientContext();
    }
  }

  private handleDoubleTapModifier() {
    const { capture, window: win } = this.deps;

    this.startedInCompactMode = win.isCompactMode();
    this.contextBeforeGesture = capture.getChatContextSnapshot();
    capture.setRadialContextShouldCommit(false);

    void this.handleSelection("chat");
  }

  private async handleSelection(wedge: RadialWedge) {
    const {
      capture,
      overlay,
      window: win,
      togglePetVoice,
      updateUiState,
    } = this.deps;

    switch (wedge) {
      case "dismiss": {
        this.clearScheduledRadialCapture();
        capture.cancelRadialContextCapture();
        this.restoreOrClearTransientContext();
        break;
      }
      case "capture": {
        this.clearScheduledRadialCapture();
        capture.setRadialContextShouldCommit(true);
        capture.commitStagedRadialContext(this.contextBeforeGesture);
        capture.cancelRadialContextCapture();
        updateUiState({ mode: "chat" });
        overlay.hideRadial();
        const targetWindowMode = win.getLastFocusedWindowMode();
        win.minimizeWindow();
        const regionCapture = await capture.startRegionCapture();
        if (
          regionCapture &&
          (regionCapture.screenshot || regionCapture.window)
        ) {
          const ctx =
            capture.getChatContextSnapshot() ?? capture.emptyContext();
          const isWindowClick = Boolean(
            regionCapture.window && regionCapture.screenshot,
          );
          const existing = ctx.regionScreenshots ?? [];
          const nextScreenshots =
            regionCapture.screenshot && !isWindowClick
              ? [...existing, regionCapture.screenshot]
              : existing;
          const nextWindow = regionCapture.window ?? ctx.window;
          const nextWindowScreenshot = isWindowClick
            ? regionCapture.screenshot
            : (ctx.windowScreenshot ?? null);
          const isRegionSelection = Boolean(
            regionCapture.screenshot && !regionCapture.window,
          );
          capture.setPendingChatContext({
            ...ctx,
            window: isRegionSelection ? null : nextWindow,
            windowScreenshot: isRegionSelection ? null : nextWindowScreenshot,
            windowContextEnabled: isRegionSelection
              ? undefined
              : regionCapture.window
                ? undefined
                : ctx.windowContextEnabled,
            regionScreenshots: nextScreenshots,
          });
          capture.broadcastChatContext();
        }
        // Cancel (Escape / exit without capturing) resolves null; leave the window minimized.
        if (regionCapture !== null) {
          win.showWindow(targetWindowMode);
        }
        break;
      }
      case "chat": {
        this.clearScheduledRadialCapture();
        capture.cancelRadialContextCapture();
        this.restoreOrClearTransientContext();
        updateUiState({ mode: "chat" });
        capture.broadcastChatContext();
        const shouldCloseMini =
          (win.isCompactMode() && win.isWindowFocused()) ||
          (win.isMiniShowing() && win.isMiniAlwaysOnTop());
        if (shouldCloseMini) {
          win.minimizeWindow();
        } else {
          win.showWindow("mini");
        }
        break;
      }
      case "add": {
        capture.setRadialContextShouldCommit(true);
        capture.commitStagedRadialContext(this.contextBeforeGesture);
        break;
      }
      case "voice": {
        this.clearScheduledRadialCapture();
        capture.cancelRadialContextCapture();
        this.restoreOrClearTransientContext();
        togglePetVoice();
        break;
      }
    }
  }

  start() {
    if (!this.deps.shouldEnable()) {
      this.stop();
      return;
    }

    const { capture, overlay, window: win } = this.deps;
    this.radialTriggerKey = this.deps.getRadialTriggerKey();
    this.miniDoubleTapModifier = this.deps.getMiniDoubleTapModifier();

    if (this.mouseHook) {
      this.mouseHook.setRadialTriggerKey(this.radialTriggerKey);
      this.mouseHook.setMiniDoubleTapModifier(this.miniDoubleTapModifier);
      // Retry hook startup after macOS Accessibility changes land. uIOhook can
      // fail once while TCC is still updating, and we do not want to require a
      // full app restart before the radial works again.
      this.mouseHook.start();
      return;
    }

    this.mouseHook = new MouseHookManager(
      {
        onRadialShow: () => {
          // Do not gate on renderer "app ready" (onboarding/kernel). The radial is a
          // system-level overlay; hooks must work even if setAppReady never fired.
          this.startedInCompactMode = win.isCompactMode();
          this.contextBeforeGesture = capture.getChatContextSnapshot();
          capture.setRadialContextShouldCommit(false);

          if (!this.startedInCompactMode && capture.getChatContextSnapshot()) {
            capture.clearTransientContext();
          }

          this.selectionCommitted = false;
          const windowFocused = win.isWindowFocused();
          const compactFocused = win.isCompactMode() && windowFocused;
          overlay.showRadial({
            compactFocused,
            miniAlwaysOnTop: win.isMiniShowing() && win.isMiniAlwaysOnTop(),
          });
          const cursorPoint = screen.getCursorScreenPoint();
          this.scheduleRadialContextCapture(cursorPoint);
        },
        onRadialHide: () => {
          if (!this.selectionCommitted) {
            this.clearScheduledRadialCapture();
            capture.cancelRadialContextCapture();
            const pendingChatContext = capture.getChatContextSnapshot();
            if (this.startedInCompactMode) {
              if (pendingChatContext !== this.contextBeforeGesture) {
                capture.setPendingChatContext(this.contextBeforeGesture);
              }
            } else if (pendingChatContext !== null) {
              capture.clearTransientContext();
            }
          }
          this.selectionCommitted = false;
          overlay.hideRadial();
        },
        onMouseMove: (x: number, y: number) => {
          overlay.updateRadialCursor(x, y);
        },
        onTriggerUp: () => {
          const radialBounds = overlay.getRadialBounds();
          if (!radialBounds) {
            return;
          }

          const cursorDip = screen.getCursorScreenPoint();
          const relativeX = cursorDip.x - radialBounds.x;
          const relativeY = cursorDip.y - radialBounds.y;
          const wedge = calculateSelectedWedge(
            relativeX,
            relativeY,
            RADIAL_SIZE / 2,
            RADIAL_SIZE / 2,
          );
          this.selectionCommitted = true;
          void this.handleSelection(wedge);
        },
        onDoubleTapModifier: () => {
          this.handleDoubleTapModifier();
        },
        isDictationPushToTalkEnabled: () =>
          this.dictationPushToTalkHandlers?.isEnabled() ?? false,
        onDictationPushToTalkStart: () => {
          this.dictationPushToTalkHandlers?.start();
        },
        onDictationPushToTalkStop: (durationMs) => {
          this.dictationPushToTalkHandlers?.stop(durationMs);
        },
        onDictationPushToTalkCancel: () => {
          this.dictationPushToTalkHandlers?.cancel();
        },
        onDictationPushToTalkDiscard: () => {
          this.dictationPushToTalkHandlers?.discard();
        },
        onLeftMouseUp: this.deps.onLeftMouseUp
          ? (event) => {
              this.deps.onLeftMouseUp?.(event);
            }
          : undefined,
      },
      this.radialTriggerKey,
      this.miniDoubleTapModifier,
    );

    this.mouseHook.start();
  }

  stop() {
    this.clearScheduledRadialCapture();
    this.selectionCommitted = false;
    this.startedInCompactMode = false;
    this.contextBeforeGesture = null;
    this.deps.capture.cancelRadialContextCapture();
    this.deps.overlay.hideRadial();
    if (this.mouseHook) {
      this.mouseHook.stop();
      this.mouseHook = null;
    }
  }

  setRadialTriggerKey(radialTriggerKey: RadialTriggerCode) {
    this.radialTriggerKey = radialTriggerKey;
    this.mouseHook?.setRadialTriggerKey(radialTriggerKey);
  }

  setMiniDoubleTapModifier(modifier: MiniDoubleTapModifier) {
    this.miniDoubleTapModifier = modifier;
    this.mouseHook?.setMiniDoubleTapModifier(modifier);
  }

  setDictationPushToTalkHandlers(handlers: DictationPushToTalkHandlers) {
    this.dictationPushToTalkHandlers = handlers;
  }
}
