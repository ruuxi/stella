import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Maximize2, Plus, Sparkles, X } from "lucide-react";
import { getPlatform } from "@/platform/electron/platform";
import "./OnboardingDoubleTapPhase.css";

type DoubleTapPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type KeycapState = "idle" | "first" | "second";

const DOUBLE_TAP_WINDOW_MS = 350;
const SUMMON_RESET_MS = 4200;

const KEY_LABEL_BY_PLATFORM: Record<
  string,
  { glyph: string; name: string; aria: string }
> = {
  darwin: { glyph: "⌥", name: "Option", aria: "Option key" },
  win32: { glyph: "Alt", name: "Alt", aria: "Alt key" },
  linux: { glyph: "Alt", name: "Alt", aria: "Alt key" },
};

/**
 * Onboarding "Double-tap to summon" phase.
 *
 * Mirrors the layout of the Live Memory phase (lede + interactive mock
 * window + Continue) but instead of a comparison grid we show one big
 * desktop-background surface. The user practices tapping Option/Alt twice
 * and the mock mini window animates in — same visual language as the
 * `scene-effect__mini-shell` used elsewhere in onboarding.
 *
 * The detection here is a renderer-side mirror of the main-process
 * `DoubleTapAltDetector`: two solo Alt taps within `DOUBLE_TAP_WINDOW_MS`
 * with no other key in between. The real gesture is handled in the main
 * process (see `desktop/electron/input/mouse-hook.ts`); this is purely
 * a teaching surface.
 */
export function OnboardingDoubleTapPhase({
  splitTransitionActive,
  onContinue,
}: DoubleTapPhaseProps) {
  const platform = getPlatform();
  const keyMeta = useMemo(
    () => KEY_LABEL_BY_PLATFORM[platform] ?? KEY_LABEL_BY_PLATFORM.darwin,
    [platform],
  );

  // Live keycap pulse: highlights the *first* cap on the first tap and the
  // *second* cap when the second tap lands within the window. Resets if the
  // user pauses too long between taps.
  const [keycapState, setKeycapState] = useState<KeycapState>("idle");
  const [miniVisible, setMiniVisible] = useState(false);
  const [hasSummoned, setHasSummoned] = useState(false);

  // Renderer-side mirror of the main-process state machine. Refs so we don't
  // re-render the whole phase on every keypress.
  const stateRef = useRef<"idle" | "first-down" | "first-up">("idle");
  const firstUpAtRef = useRef(0);
  const altDownRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summonResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const clearSummonResetTimer = useCallback(() => {
    if (summonResetTimerRef.current) {
      clearTimeout(summonResetTimerRef.current);
      summonResetTimerRef.current = null;
    }
  }, []);

  const resetKeycaps = useCallback(() => {
    setKeycapState("idle");
    stateRef.current = "idle";
    firstUpAtRef.current = 0;
    clearResetTimer();
  }, [clearResetTimer]);

  const triggerSummon = useCallback(() => {
    setHasSummoned(true);
    setMiniVisible(true);
    clearSummonResetTimer();
    // Auto-tuck the mock back so the user can practice again — the gesture
    // is a toggle in the real product, but in the demo we want to invite
    // a few repetitions without making them perform "tap to dismiss".
    summonResetTimerRef.current = setTimeout(() => {
      setMiniVisible(false);
      summonResetTimerRef.current = null;
    }, SUMMON_RESET_MS);
  }, [clearSummonResetTimer]);

  useEffect(() => {
    const isAltCode = (code: string) =>
      code === "AltLeft" || code === "AltRight";

    const handleKeydown = (event: KeyboardEvent) => {
      // Only the Option/Alt key participates in the gesture; treat any
      // other key as a cancel so the user has to start over (matches the
      // main-process behavior).
      if (!isAltCode(event.code)) {
        if (stateRef.current !== "idle") {
          resetKeycaps();
        }
        return;
      }

      // Auto-repeat suppression: the OS resends keydown while the key is
      // held. Only the first keydown should advance the state machine.
      if (altDownRef.current) return;
      altDownRef.current = true;

      const now = performance.now();

      if (stateRef.current === "first-up") {
        if (now - firstUpAtRef.current <= DOUBLE_TAP_WINDOW_MS) {
          stateRef.current = "idle";
          firstUpAtRef.current = 0;
          setKeycapState("second");
          clearResetTimer();
          triggerSummon();
          // Settle the second keycap pulse back to idle after a moment.
          resetTimerRef.current = setTimeout(() => {
            setKeycapState("idle");
            resetTimerRef.current = null;
          }, 420);
          // Don't let the demo eat the user's actual keypress — let it
          // bubble for accessibility (focus traversal, etc.).
          return;
        }
      }

      stateRef.current = "first-down";
      setKeycapState("first");
    };

    const handleKeyup = (event: KeyboardEvent) => {
      if (!isAltCode(event.code)) return;
      altDownRef.current = false;

      if (stateRef.current === "first-down") {
        stateRef.current = "first-up";
        firstUpAtRef.current = performance.now();
        clearResetTimer();
        // If the user hesitates beyond the gesture window, drop the lit
        // keycap so it's clear they need to start over.
        resetTimerRef.current = setTimeout(() => {
          if (stateRef.current === "first-up") {
            resetKeycaps();
          }
        }, DOUBLE_TAP_WINDOW_MS + 80);
      }
    };

    const handleBlur = () => {
      altDownRef.current = false;
      resetKeycaps();
    };

    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("keyup", handleKeyup);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
      window.removeEventListener("blur", handleBlur);
      clearResetTimer();
      clearSummonResetTimer();
    };
  }, [
    clearResetTimer,
    clearSummonResetTimer,
    resetKeycaps,
    triggerSummon,
  ]);

  return (
    <div className="onboarding-step-content onboarding-doubletap-step">
      <p className="onboarding-step-desc onboarding-doubletap-step__lede">
        Tap{" "}
        <kbd className="onboarding-doubletap-inline-kbd">{keyMeta.glyph}</kbd>{" "}
        twice — fast — to bring up the mini window from anywhere on your
        computer. Tap it twice again to tuck it away.
      </p>

      <div className="onboarding-doubletap-stage" data-summoned={hasSummoned || undefined}>
        <div className="onboarding-doubletap-desktop" aria-hidden="true">
          <div className="onboarding-doubletap-window onboarding-doubletap-window--bg">
            <div className="onboarding-doubletap-window__bar">
              <span />
              <span />
              <span />
              <strong>Notes</strong>
            </div>
            <div className="onboarding-doubletap-window__body">
              <div className="onboarding-doubletap-line onboarding-doubletap-line--title" />
              <div className="onboarding-doubletap-line" />
              <div className="onboarding-doubletap-line onboarding-doubletap-line--med" />
              <div className="onboarding-doubletap-line onboarding-doubletap-line--short" />
              <div className="onboarding-doubletap-line" />
            </div>
          </div>

          <div className="onboarding-doubletap-window onboarding-doubletap-window--front">
            <div className="onboarding-doubletap-window__bar">
              <span />
              <span />
              <span />
              <strong>Research Brief</strong>
            </div>
            <div className="onboarding-doubletap-window__body onboarding-doubletap-window__body--front">
              <span className="onboarding-doubletap-eyebrow">
                Q2 2026 Analysis
              </span>
              <h4 className="onboarding-doubletap-heading">
                Market Performance Overview
              </h4>
              <p className="onboarding-doubletap-paragraph">
                Revenue increased 23% year-over-year, driven by strong
                enterprise adoption across three core verticals.
              </p>
              <p className="onboarding-doubletap-paragraph onboarding-doubletap-paragraph--muted">
                The mid-market segment showed early traction with 14%
                quarterly growth.
              </p>
            </div>
          </div>

          <div
            className="onboarding-doubletap-mini"
            data-visible={miniVisible || undefined}
          >
            <div className="onboarding-doubletap-mini__bar">
              <span className="onboarding-doubletap-mini__brand">
                <Sparkles size={11} />
                Stella
              </span>
              <div className="onboarding-doubletap-mini__actions">
                <Maximize2 size={11} />
                <X size={11} />
              </div>
            </div>
            <div className="onboarding-doubletap-mini__messages">
              <div className="onboarding-doubletap-mini__msg onboarding-doubletap-mini__msg--assistant">
                Hey — what can I help with?
              </div>
              <div className="onboarding-doubletap-mini__msg onboarding-doubletap-mini__msg--user">
                Draft a reply to the latest message
              </div>
              <div className="onboarding-doubletap-mini__msg onboarding-doubletap-mini__msg--assistant">
                On it. I'll keep it short and warm — want me to hold the
                ask until tomorrow morning?
              </div>
            </div>
            <div className="onboarding-doubletap-mini__composer">
              <span
                className="onboarding-doubletap-mini__composer-add"
                aria-hidden="true"
              >
                <Plus size={11} />
              </span>
              <span className="onboarding-doubletap-mini__composer-input">
                Ask Stella…
              </span>
              <span
                className="onboarding-doubletap-mini__composer-submit"
                aria-hidden="true"
              >
                <ArrowUp size={11} />
              </span>
            </div>
          </div>
        </div>

        <div className="onboarding-doubletap-hint" aria-live="polite">
          {!hasSummoned ? (
            <span>Try it now — tap {keyMeta.name} twice, fast.</span>
          ) : null}
        </div>
      </div>

      <div className="onboarding-doubletap-keycaps" aria-hidden="true">
        <span
          className="onboarding-doubletap-keycap"
          data-state={keycapState === "idle" ? undefined : keycapState}
          aria-label={keyMeta.aria}
        >
          {keyMeta.glyph}
        </span>
        <span className="onboarding-doubletap-keycap-sep">+</span>
        <span
          className="onboarding-doubletap-keycap"
          data-state={keycapState === "second" ? "second" : undefined}
          aria-label={keyMeta.aria}
        >
          {keyMeta.glyph}
        </span>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
