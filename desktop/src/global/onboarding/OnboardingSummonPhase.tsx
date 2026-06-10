/**
 * Summon phase — the three ways to call Stella, taught by doing.
 *
 * One row of practice cards: double-tap Option for the mini chat, hold
 * the chord for the radial dial, right-click inside the app for the
 * side panel. Nothing auto-plays; each card completes only when the
 * user actually performs the gesture. Global OS shortcuts are suspended
 * during onboarding, so the renderer receives the raw key events here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Plus } from "@/ui/icons";
import { getPlatform } from "@/platform/electron/platform";
import { getRadialTriggerLabel } from "@/shared/lib/radial-trigger";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { RadialDialDemo } from "./panels/radial/RadialDialDemo";
import "./OnboardingSummonPhase.css";

type SummonPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type KeycapState = "idle" | "first" | "second";

const DOUBLE_TAP_WINDOW_MS = 350;
const CONTINUE_GRACE_MS = 7000;

const KEY_LABEL_BY_PLATFORM: Record<string, { glyph: string; name: string }> = {
  darwin: { glyph: "⌥", name: "Option" },
  win32: { glyph: "Alt", name: "Alt" },
  linux: { glyph: "Alt", name: "Alt" },
};

function CompletionCheck({ done }: { done: boolean }) {
  return (
    <span className="osummon-check" data-visible={done || undefined}>
      <Check size={12} aria-hidden />
    </span>
  );
}

export function OnboardingSummonPhase({
  splitTransitionActive,
  onContinue,
}: SummonPhaseProps) {
  const platform = getPlatform();
  const keyMeta =
    KEY_LABEL_BY_PLATFORM[platform] ?? KEY_LABEL_BY_PLATFORM.darwin;
  const chordLabel = useMemo(
    () => getRadialTriggerLabel("SystemChord", platform),
    [platform],
  );

  const [doubleTapDone, setDoubleTapDone] = useState(false);
  const [dialDone, setDialDone] = useState(false);
  const [rightClickDone, setRightClickDone] = useState(false);
  const [keycapState, setKeycapState] = useState<KeycapState>("idle");
  const [graceElapsed, setGraceElapsed] = useState(false);

  // Renderer-side mirror of the main-process DoubleTapAltDetector: two
  // solo Alt taps within the window, any other key cancels. Refs so we
  // don't re-render the phase on every keypress.
  const tapStateRef = useRef<"idle" | "first-down" | "first-up">("idle");
  const firstUpAtRef = useRef(0);
  const altDownRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const resetKeycaps = useCallback(() => {
    setKeycapState("idle");
    tapStateRef.current = "idle";
    firstUpAtRef.current = 0;
    clearResetTimer();
  }, [clearResetTimer]);

  useEffect(() => {
    if (doubleTapDone) return;

    const isAltCode = (code: string) =>
      code === "AltLeft" || code === "AltRight";

    const handleKeydown = (event: KeyboardEvent) => {
      // Any non-Alt key cancels the gesture so the user starts over —
      // matches the main-process behavior.
      if (!isAltCode(event.code)) {
        if (tapStateRef.current !== "idle") {
          resetKeycaps();
        }
        return;
      }

      // Auto-repeat suppression: only the first keydown of a held key
      // advances the state machine.
      if (altDownRef.current) return;
      altDownRef.current = true;

      const now = performance.now();

      if (
        tapStateRef.current === "first-up" &&
        now - firstUpAtRef.current <= DOUBLE_TAP_WINDOW_MS
      ) {
        tapStateRef.current = "idle";
        firstUpAtRef.current = 0;
        clearResetTimer();
        setKeycapState("second");
        setDoubleTapDone(true);
        return;
      }

      tapStateRef.current = "first-down";
      setKeycapState("first");
    };

    const handleKeyup = (event: KeyboardEvent) => {
      if (!isAltCode(event.code)) return;
      altDownRef.current = false;

      if (tapStateRef.current === "first-down") {
        tapStateRef.current = "first-up";
        firstUpAtRef.current = performance.now();
        clearResetTimer();
        // If the user hesitates beyond the gesture window, drop the lit
        // keycap so it's clear they need to start over.
        resetTimerRef.current = setTimeout(() => {
          if (tapStateRef.current === "first-up") {
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
    };
  }, [clearResetTimer, doubleTapDone, resetKeycaps]);

  // Grace timer: nobody gets hard-stuck if a gesture won't land on
  // their setup — Continue appears on its own after a short wait.
  useEffect(() => {
    const timer = setTimeout(() => setGraceElapsed(true), CONTINUE_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleDialActivated = useCallback(() => {
    setDialDone(true);
  }, []);

  const completedCount =
    Number(doubleTapDone) + Number(dialDone) + Number(rightClickDone);
  const continueVisible = completedCount > 0 || graceElapsed;

  const caption =
    completedCount === 3
      ? "All three, mastered."
      : completedCount > 0
        ? "Nice. The other two work the same way whenever you want them."
        : "These work everywhere on this computer, not just inside this window.";

  return (
    <div className="onboarding-step-content osummon-step">
      <div className="osummon-grid">
        <section
          className="osummon-card"
          data-complete={doubleTapDone || undefined}
        >
          <CompletionCheck done={doubleTapDone} />
          <span className="osummon-card__label">Double-tap {keyMeta.name}</span>
          <p className="osummon-card__instruction">
            Double-tap {keyMeta.name} to pop open the mini chat over any app.
          </p>
          <div className="osummon-card__surface osummon-card__surface--keys">
            <div
              className="osummon-keycaps"
              data-done={doubleTapDone || undefined}
              aria-hidden="true"
            >
              <span
                className="osummon-keycap"
                data-state={keycapState === "idle" ? undefined : keycapState}
              >
                {keyMeta.glyph}
              </span>
              <span
                className="osummon-keycap"
                data-state={keycapState === "second" ? "second" : undefined}
              >
                {keyMeta.glyph}
              </span>
            </div>
            <div
              className="osummon-mini"
              data-visible={doubleTapDone || undefined}
              aria-hidden="true"
            >
              <div className="osummon-mini__bar">
                <StellaLogoIcon size={10} aria-hidden />
                Stella
              </div>
              <div className="osummon-mini__msg">
                Here whenever you need a hand.
              </div>
              <div className="osummon-mini__composer">
                <Plus size={10} />
                <span className="osummon-mini__composer-input">
                  Ask Stella…
                </span>
                <ArrowUp size={10} />
              </div>
            </div>
          </div>
        </section>

        <section className="osummon-card" data-complete={dialDone || undefined}>
          <CompletionCheck done={dialDone} />
          <span className="osummon-card__label">Hold the dial</span>
          <p className="osummon-card__instruction">
            Capture, chat, and voice sit one move away on the dial. Try holding{" "}
            {chordLabel}.
          </p>
          <div className="osummon-card__surface osummon-card__surface--dial">
            <RadialDialDemo onActivated={handleDialActivated} />
          </div>
        </section>

        <section
          className="osummon-card"
          data-complete={rightClickDone || undefined}
        >
          <CompletionCheck done={rightClickDone} />
          <span className="osummon-card__label">Right-click inside Stella</span>
          <p className="osummon-card__instruction">
            Right-click anywhere inside the app to open the side panel.
          </p>
          <div
            className="osummon-card__surface osummon-card__surface--mock"
            onContextMenu={(event) => {
              event.preventDefault();
              setRightClickDone(true);
            }}
          >
            <div className="osummon-mock" aria-hidden="true">
              <div className="osummon-mock__bar">
                <span />
                <span />
                <span />
              </div>
              <div className="osummon-mock__body">
                <div className="osummon-mock__main">
                  <div className="osummon-mock__wordmark">Stella</div>
                  <div className="osummon-mock__line osummon-mock__line--wide" />
                  <div className="osummon-mock__line" />
                  <div className="osummon-mock__line osummon-mock__line--short" />
                </div>
                <div
                  className="osummon-mock__panel"
                  data-open={rightClickDone || undefined}
                >
                  <div className="osummon-mock__panel-row" />
                  <div className="osummon-mock__panel-row" />
                  <div className="osummon-mock__panel-row" />
                  <div className="osummon-mock__panel-row" />
                </div>
              </div>
            </div>
            {!rightClickDone ? (
              <span className="osummon-hint">Try it here</span>
            ) : null}
          </div>
        </section>
      </div>

      <div className="osummon-caption-slot" aria-live="polite">
        <p className="osummon-caption" key={caption}>
          {caption}
        </p>
      </div>

      <button
        className="onboarding-confirm osummon-continue"
        data-visible={continueVisible}
        data-emphasized={completedCount > 0 || undefined}
        disabled={splitTransitionActive || !continueVisible}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
