import { uIOhook, UiohookKeyboardEvent, UiohookMouseEvent } from "uiohook-napi";
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  isRadialTriggerPressed,
  type RadialTriggerCode,
} from "../../src/shared/lib/radial-trigger.js";
import {
  DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  type MiniDoubleTapModifier,
} from "../../src/shared/lib/mini-double-tap.js";
import { areGlobalShortcutsSuspended } from "../ipc/global-shortcuts.js";

// uIOhook keycodes for the Option/Alt key (left + right). On macOS this is
// the Option key; on Windows/Linux it is the Alt key. Mapped from
// `UiohookKey.Alt` (56) and `UiohookKey.AltRight` (3640).
const LEFT_ALT = 56;
const RIGHT_ALT = 3640;
const LEFT_META = 3675;
const RIGHT_META = 3676;
const LEFT_CONTROL = 29;
const RIGHT_CONTROL = 3613;
const LEFT_SHIFT = 42;
const RIGHT_SHIFT = 54;
const MODIFIER_KEYCODES: Record<
  Exclude<MiniDoubleTapModifier, "Off">,
  ReadonlySet<number>
> = {
  Alt: new Set([LEFT_ALT, RIGHT_ALT]),
  Control: new Set([LEFT_CONTROL, RIGHT_CONTROL]),
  Command: new Set([LEFT_META, RIGHT_META]),
  Shift: new Set([LEFT_SHIFT, RIGHT_SHIFT]),
};

// Candidate uIOhook keycodes that any radial trigger can possibly watch:
// every single-key trigger uses a code in 1..57, and the SystemChord adds the
// extended Option/Alt + Cmd/Meta codes. Probed once per trigger change to
// precompute `watchedRadialKeycodes`; never read on the per-event hot path.
const RADIAL_TRIGGER_CANDIDATE_KEYCODES: readonly number[] = [
  ...Array.from({ length: 57 }, (_, i) => i + 1),
  RIGHT_ALT,
  LEFT_META,
  RIGHT_META,
];

// Modifier keycodes a chord trigger may use. Watched wholesale when the trigger
// is a chord (see recomputeWatchedRadialKeycodes); over-inclusive on purpose so
// the hot-path early-return can never miss a chord-participating key.
const RADIAL_TRIGGER_MODIFIER_KEYCODES: readonly number[] = [
  LEFT_ALT,
  RIGHT_ALT,
  LEFT_META,
  RIGHT_META,
  LEFT_CONTROL,
  RIGHT_CONTROL,
  LEFT_SHIFT,
  RIGHT_SHIFT,
];

const LEFT_MOUSE_BUTTON = 1;

// Max time (ms) between the first Alt keyup and the second Alt keydown for
// the gesture to count as a "double-tap". 350ms matches the typical OS
// double-click threshold and feels fast-but-not-twitchy in practice.
const DOUBLE_TAP_WINDOW_MS = 350;
// Audio capture starts immediately on Option/Alt down so speech from the first
// 150ms is not lost when the user intended dictation. This delay only gates the
// visible push-to-talk affordance / chord cancellation window.
const DICTATION_PUSH_TO_TALK_TRIGGER_DELAY_MS = 150;

export type LeftMouseUpEvent = {
  x: number;
  y: number;
  /**
   * Manhattan distance between the matching left-mousedown coordinates
   * and this mouseup. Consumers use this as a "did the user drag?" gate
   * — a true click hovers near zero; a text selection drags > 4px.
   */
  dragDistance: number;
};

type MouseHookEvents = {
  /**
   * Fired when the radial trigger chord transitions from "not held" → "held"
   * (e.g. user just pressed Option+Cmd on macOS). Consumers should show the
   * radial dial overlay at the current cursor position.
   */
  onRadialShow: () => void;
  /**
   * Fired when the radial trigger chord is released (or the user pressed a
   * non-trigger key cancelling the gesture). Consumers should hide the
   * radial overlay.
   */
  onRadialHide: () => void;
  /**
   * Fired on every mouse-move while the radial is active. Coordinates are
   * native screen pixels.
   */
  onMouseMove: (x: number, y: number) => void;
  /**
   * Fired right before `onRadialHide` when the trigger chord was released
   * cleanly (vs. cancelled). Consumers use this to commit the wedge under
   * the cursor.
   */
  onTriggerUp: () => void;
  /**
   * Fired when the user taps the Option (macOS) / Alt (Windows / Linux) key
   * twice in rapid succession with no other keys pressed in between. The
   * gesture is purely keyboard, so no coordinates are supplied.
   */
  onDoubleTapModifier?: () => void;
  /**
   * Fired for Option/Alt-alone push-to-talk dictation. This is separate from
   * Electron global shortcuts because push-to-talk needs key-down and key-up.
   */
  onDictationPushToTalkStart?: () => void;
  onDictationPushToTalkReveal?: () => void;
  onDictationPushToTalkStop?: (durationMs: number) => void;
  onDictationPushToTalkCancel?: () => void;
  onDictationPushToTalkDiscard?: () => void;
  isDictationPushToTalkEnabled?: () => boolean;
  /**
   * Fired on every global left-mouse-button release. Used by the selection
   * watcher to trigger an "Ask Stella" pill above any text the user just
   * finished selecting; only attached when a consumer actually needs it.
   */
  onLeftMouseUp?: (event: LeftMouseUpEvent) => void;
};

/**
 * Tiny state machine that fires once when the user double-taps the Option
 * (macOS) / Alt (Windows / Linux) key. The gesture is "two solo taps within
 * `DOUBLE_TAP_WINDOW_MS`" — any other key pressed in between cancels the
 * sequence so we don't false-trigger while typing.
 */
class DoubleTapModifierDetector {
  private state: "idle" | "first-down" | "first-up" | "second-down" = "idle";
  private firstTapUpAt = 0;

  constructor(
    private modifier: MiniDoubleTapModifier,
    private readonly fire: () => void,
  ) {}

  setModifier(modifier: MiniDoubleTapModifier) {
    this.modifier = modifier;
    this.reset();
  }

  isModifierKey(keycode: number) {
    if (this.modifier === "Off") return false;
    return MODIFIER_KEYCODES[this.modifier]?.has(keycode) ?? false;
  }

  // Cheap predicate for the keydown/keyup hot-path early-return: when the
  // double-tap modifier is "Off" the detector ignores every key, so callers
  // can skip per-event work entirely. Mirrors the "Off" guard in isModifierKey.
  isWatching() {
    return this.modifier !== "Off";
  }

  notifyModifierKeydown(now: number) {
    if (this.state === "first-up") {
      if (now - this.firstTapUpAt <= DOUBLE_TAP_WINDOW_MS) {
        this.state = "second-down";
        return;
      }
      this.reset();
    }
    this.state = "first-down";
  }

  notifyModifierKeyup(now: number) {
    if (this.state === "first-down") {
      this.state = "first-up";
      this.firstTapUpAt = now;
    } else if (this.state === "second-down") {
      this.reset();
      this.fire();
    } else {
      this.reset();
    }
  }

  cancel() {
    this.reset();
  }

  private reset() {
    this.state = "idle";
    this.firstTapUpAt = 0;
  }
}

/**
 * Listens for global input gestures and forwards them as semantic events.
 *
 * Currently surfaces:
 *   - Radial chord (default Option+Cmd on macOS / Alt+Win on Windows / Linux):
 *     `onRadialShow` on press, `onMouseMove` while held, `onTriggerUp` then
 *     `onRadialHide` on release.
 *   - Option/Alt double-tap → `onDoubleTapModifier`.
 *   - Left-mouse-button release → `onLeftMouseUp`.
 *
 * The radial chord is a keyboard gesture, so we never need to swallow the
 * OS context menu — uIOhook is enough on every platform.
 */
export class MouseHookManager {
  private events: MouseHookEvents;
  private started = false;
  private uiohookListenersAttached = false;
  private uiohookStarted = false;
  private mousemoveListenerAttached = false;
  private pressedKeycodes = new Set<number>();
  private radialActive = false;
  private radialTriggerKey: RadialTriggerCode;
  // Precomputed set of keycodes that the *current* radial trigger reacts to.
  // Built only when the trigger changes (constructor / setRadialTriggerKey), so
  // the keydown/keyup hot-path can decide relevance with a single Set lookup
  // instead of calling matchesTriggerKey() (which scans pressedKeycodes) on
  // every system-wide keystroke.
  private watchedRadialKeycodes: Set<number> = new Set();
  private readonly doubleTapDetector: DoubleTapModifierDetector | null;
  private lastLeftDownPoint: { x: number; y: number } | null = null;
  private dictationKeyDownAt: number | null = null;
  private dictationStartTimer: ReturnType<typeof setTimeout> | null = null;
  private dictationStarted = false;

  constructor(
    events: MouseHookEvents,
    radialTriggerKey: RadialTriggerCode = DEFAULT_RADIAL_TRIGGER_CODE,
    miniDoubleTapModifier: MiniDoubleTapModifier = DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  ) {
    this.events = events;
    this.radialTriggerKey = radialTriggerKey;
    this.recomputeWatchedRadialKeycodes();
    this.doubleTapDetector = events.onDoubleTapModifier
      ? new DoubleTapModifierDetector(
          miniDoubleTapModifier,
          events.onDoubleTapModifier,
        )
      : null;
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.attachUiohookListeners();

    if (!this.uiohookStarted) {
      try {
        uIOhook.start();
        this.uiohookStarted = true;
      } catch (error) {
        console.error(
          "[mouse-hook] Failed to start input hook:",
          (error as Error).message,
        );
      }
    }
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.pressedKeycodes.clear();
    this.radialActive = false;
    this.clearPendingDictationStart();
    this.dictationStarted = false;
    this.doubleTapDetector?.cancel();

    if (this.uiohookStarted) {
      try {
        uIOhook.stop();
      } catch (error) {
        console.warn(
          "[mouse-hook] Failed to stop input hook:",
          (error as Error).message,
        );
      }
      this.uiohookStarted = false;
    }
    this.detachUiohookListeners();
  }

  setRadialTriggerKey(radialTriggerKey: RadialTriggerCode) {
    this.radialTriggerKey = radialTriggerKey;
    this.recomputeWatchedRadialKeycodes();
  }

  // Rebuild the set of keycodes the current trigger reacts to, using only the
  // existing isRadialTriggerPressed() contract so detection stays byte-for-byte
  // identical to matchesTriggerKey(). Off the hot path: only runs on trigger
  // change.
  //   - Single-key triggers: a key is watched iff pressing it alone satisfies
  //     the trigger (single reused 1-element probe set → no per-call alloc).
  //   - Chord triggers: no single key satisfies them, so we instead detect the
  //     chord (full candidate set passes, no singleton does) and watch every
  //     modifier candidate. Over-inclusion here is always safe — it only makes
  //     the hot-path early-return fire slightly less often, never wrong.
  private recomputeWatchedRadialKeycodes() {
    const watched = new Set<number>();
    const probe = new Set<number>();
    for (const keycode of RADIAL_TRIGGER_CANDIDATE_KEYCODES) {
      probe.clear();
      probe.add(keycode);
      if (
        isRadialTriggerPressed(this.radialTriggerKey, probe, process.platform)
      ) {
        watched.add(keycode);
      }
    }
    if (watched.size === 0) {
      const allCandidates = new Set(RADIAL_TRIGGER_CANDIDATE_KEYCODES);
      if (
        isRadialTriggerPressed(
          this.radialTriggerKey,
          allCandidates,
          process.platform,
        )
      ) {
        for (const keycode of RADIAL_TRIGGER_MODIFIER_KEYCODES) {
          watched.add(keycode);
        }
      }
    }
    this.watchedRadialKeycodes = watched;
  }

  setMiniDoubleTapModifier(modifier: MiniDoubleTapModifier) {
    this.doubleTapDetector?.setModifier(modifier);
  }

  isRadialActive() {
    return this.radialActive;
  }

  /**
   * Whether the underlying uiohook actually started delivering events —
   * false when accessibility permission is missing or startup failed.
   */
  isHookRunning() {
    return this.uiohookStarted;
  }

  private matchesTriggerKey(): boolean {
    return isRadialTriggerPressed(
      this.radialTriggerKey,
      this.pressedKeycodes,
      process.platform,
    );
  }

  // Hot-path gate: returns true when this keystroke cannot affect any gesture,
  // so handleKeydown/handleKeyup can bail before any allocation, Set mutation,
  // matchesTriggerKey() scan, isDictationPushToTalkEnabled?.() call or Date.now()
  // — the common case while the user types in another app. A key is irrelevant
  // only when (a) it is not part of the radial trigger (so it cannot start/end
  // the radial, and skipping it cannot leave stale pressedKeycodes), (b) it is
  // not Alt (so it cannot start/stop push-to-talk dictation), (c) the double-tap
  // detector is not watching, (d) no dictation press is in flight, and (e) the
  // radial is not currently open. When any feature IS live the full handler runs
  // unchanged. Cheap: only Set lookups and field reads.
  private isIrrelevantHotPathKey(keycode: number): boolean {
    return (
      !this.watchedRadialKeycodes.has(keycode) &&
      !MODIFIER_KEYCODES.Alt.has(keycode) &&
      this.doubleTapDetector?.isWatching() !== true &&
      this.dictationKeyDownAt === null &&
      !this.radialActive
    );
  }

  private clearPendingDictationStart() {
    if (this.dictationStartTimer) {
      clearTimeout(this.dictationStartTimer);
      this.dictationStartTimer = null;
    }
    this.dictationKeyDownAt = null;
  }

  private cancelPendingDictationStart() {
    const hadPendingStart =
      this.dictationKeyDownAt !== null && !this.dictationStarted;
    this.clearPendingDictationStart();
    if (hadPendingStart) {
      this.events.onDictationPushToTalkDiscard?.();
    }
  }

  private suppressActiveGestures() {
    const hadPendingDictation =
      this.dictationKeyDownAt !== null || this.dictationStarted;
    const hadActiveRadial = this.radialActive;

    this.pressedKeycodes.clear();
    this.clearPendingDictationStart();
    this.dictationStarted = false;
    this.doubleTapDetector?.cancel();

    if (hadPendingDictation) {
      this.events.onDictationPushToTalkCancel?.();
    }
    if (hadActiveRadial) {
      this.events.onRadialHide();
      this.radialActive = false;
      this.detachMousemove();
    }
  }

  private attachUiohookListeners() {
    if (this.uiohookListenersAttached) return;
    this.uiohookListenersAttached = true;

    uIOhook.on("keydown", this.handleKeydown);
    uIOhook.on("keyup", this.handleKeyup);
    // `mousemove` is intentionally NOT attached here. It is the only event
    // that fires continuously during normal use, and the radial is its sole
    // consumer (only while the dial is open). Subscribing for the whole
    // session means every global mouse-move crosses the native→JS boundary
    // onto the main thread for a handler that no-ops 99% of the time — and on
    // Windows the WH_MOUSE_LL hook makes any main-thread stall delay system-
    // wide input. Attach only while the radial is active (see attachMousemove).
    uIOhook.on("mousedown", this.handleMousedown);
    if (this.events.onLeftMouseUp) {
      uIOhook.on("mouseup", this.handleMouseup);
    }
  }

  private detachUiohookListeners() {
    if (!this.uiohookListenersAttached) return;
    this.uiohookListenersAttached = false;
    uIOhook.off("keydown", this.handleKeydown);
    uIOhook.off("keyup", this.handleKeyup);
    this.detachMousemove();
    uIOhook.off("mousedown", this.handleMousedown);
    uIOhook.off("mouseup", this.handleMouseup);
  }

  /** Subscribe to global mouse-move events — only while the radial is open. */
  private attachMousemove() {
    if (this.mousemoveListenerAttached) return;
    this.mousemoveListenerAttached = true;
    uIOhook.on("mousemove", this.handleMousemove);
  }

  private detachMousemove() {
    if (!this.mousemoveListenerAttached) return;
    this.mousemoveListenerAttached = false;
    uIOhook.off("mousemove", this.handleMousemove);
  }

  private readonly handleKeydown = (event: UiohookKeyboardEvent) => {
    if (!this.started) return;
    if (areGlobalShortcutsSuspended()) {
      this.suppressActiveGestures();
      return;
    }
    // Perf: skip the per-event gesture work for keystrokes that cannot affect
    // any gesture (kept identical when a feature is live). See isIrrelevantHotPathKey.
    if (this.isIrrelevantHotPathKey(event.keycode)) return;
    const wasAlreadyDown = this.pressedKeycodes.has(event.keycode);
    this.pressedKeycodes.add(event.keycode);
    const isAlt = MODIFIER_KEYCODES.Alt.has(event.keycode);
    const dictationPushToTalkEnabled =
      this.events.isDictationPushToTalkEnabled?.() === true;
    const radialTriggerPressed = this.matchesTriggerKey();

    if (
      dictationPushToTalkEnabled &&
      isAlt &&
      !radialTriggerPressed &&
      !wasAlreadyDown &&
      this.dictationKeyDownAt === null
    ) {
      this.dictationKeyDownAt = Date.now();
      this.dictationStarted = true;
      this.events.onDictationPushToTalkStart?.();
      this.dictationStartTimer = setTimeout(() => {
        this.dictationStartTimer = null;
        if (this.dictationKeyDownAt === null || !this.dictationStarted) return;
        this.events.onDictationPushToTalkReveal?.();
      }, DICTATION_PUSH_TO_TALK_TRIGGER_DELAY_MS);
    }

    if (
      dictationPushToTalkEnabled &&
      !isAlt &&
      this.dictationKeyDownAt !== null
    ) {
      if (event.keycode === 1) {
        const hadStarted = this.dictationStarted;
        this.clearPendingDictationStart();
        this.dictationStarted = false;
        if (hadStarted) {
          this.events.onDictationPushToTalkCancel?.();
        } else {
          this.events.onDictationPushToTalkDiscard?.();
        }
        return;
      }
      if (!this.dictationStarted) {
        this.cancelPendingDictationStart();
      } else if (this.matchesTriggerKey()) {
        this.clearPendingDictationStart();
        this.dictationStarted = false;
        this.events.onDictationPushToTalkCancel?.();
      }
    }

    if (dictationPushToTalkEnabled && radialTriggerPressed) {
      if (!this.dictationStarted) {
        this.cancelPendingDictationStart();
      } else {
        this.clearPendingDictationStart();
        this.dictationStarted = false;
        this.events.onDictationPushToTalkCancel?.();
      }
    }

    // Radial chord: fire `onRadialShow` exactly when the chord transitions
    // from incomplete → complete. Holding any extra keys does not retrigger.
    if (radialTriggerPressed && !this.radialActive) {
      this.radialActive = true;
      this.attachMousemove();
      this.events.onRadialShow();
    }

    if (!this.doubleTapDetector) return;

    // Suppress auto-repeat (the OS resends keydown while a key is held).
    if (wasAlreadyDown) return;

    if (this.doubleTapDetector.isModifierKey(event.keycode)) {
      this.doubleTapDetector.notifyModifierKeydown(Date.now());
    } else {
      // Any other key pressed during the gesture cancels it — the user is
      // clearly typing/triggering something else, not double-tapping Option.
      this.doubleTapDetector.cancel();
    }
  };

  private readonly handleKeyup = (event: UiohookKeyboardEvent) => {
    if (!this.started) return;
    if (areGlobalShortcutsSuspended()) {
      this.suppressActiveGestures();
      return;
    }
    // Perf: skip the per-event gesture work for keystrokes that cannot affect
    // any gesture (kept identical when a feature is live). See isIrrelevantHotPathKey.
    if (this.isIrrelevantHotPathKey(event.keycode)) return;
    const wasTriggerHeld = this.matchesTriggerKey();
    this.pressedKeycodes.delete(event.keycode);
    const isAlt = MODIFIER_KEYCODES.Alt.has(event.keycode);
    const dictationPushToTalkEnabled =
      this.events.isDictationPushToTalkEnabled?.() === true;
    let completedLongPushToTalk = false;
    if (
      dictationPushToTalkEnabled &&
      isAlt &&
      this.dictationKeyDownAt !== null
    ) {
      const durationMs = Date.now() - this.dictationKeyDownAt;
      completedLongPushToTalk =
        this.dictationStarted &&
        durationMs >= DICTATION_PUSH_TO_TALK_TRIGGER_DELAY_MS;
      const hadStarted = this.dictationStarted;
      this.clearPendingDictationStart();
      this.dictationStarted = false;
      if (hadStarted) {
        this.events.onDictationPushToTalkStop?.(durationMs);
      } else {
        this.events.onDictationPushToTalkDiscard?.();
      }
    }
    if (wasTriggerHeld && !this.matchesTriggerKey() && this.radialActive) {
      this.events.onTriggerUp();
      this.events.onRadialHide();
      this.radialActive = false;
      this.detachMousemove();
    }

    if (!this.doubleTapDetector) return;
    if (completedLongPushToTalk) {
      this.doubleTapDetector.cancel();
    } else if (this.doubleTapDetector.isModifierKey(event.keycode)) {
      this.doubleTapDetector.notifyModifierKeyup(Date.now());
    }
  };

  private readonly handleMousemove = (event: UiohookMouseEvent) => {
    if (!this.started) return;
    if (areGlobalShortcutsSuspended()) return;
    if (this.radialActive) {
      this.events.onMouseMove(event.x, event.y);
    }
  };

  private readonly handleMousedown = (event: UiohookMouseEvent) => {
    if (!this.started) return;
    if (areGlobalShortcutsSuspended()) return;
    const button = typeof event.button === "number" ? event.button : -1;
    if (
      this.events.isDictationPushToTalkEnabled?.() === true &&
      this.dictationKeyDownAt !== null &&
      !this.dictationStarted
    ) {
      this.cancelPendingDictationStart();
      this.doubleTapDetector?.cancel();
    }
    if (button === LEFT_MOUSE_BUTTON) {
      this.lastLeftDownPoint = { x: event.x, y: event.y };
    }
  };

  private readonly handleMouseup = (event: UiohookMouseEvent) => {
    if (!this.started) return;
    if (areGlobalShortcutsSuspended()) return;
    const handler = this.events.onLeftMouseUp;
    if (!handler) return;
    const button = typeof event.button === "number" ? event.button : -1;
    if (button !== LEFT_MOUSE_BUTTON) return;
    const downPoint = this.lastLeftDownPoint;
    this.lastLeftDownPoint = null;
    const dragDistance = downPoint
      ? Math.abs(event.x - downPoint.x) + Math.abs(event.y - downPoint.y)
      : 0;
    handler({ x: event.x, y: event.y, dragDistance });
  };
}
