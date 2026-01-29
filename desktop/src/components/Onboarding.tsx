import React, { useState, useEffect, useRef, useCallback } from "react";
import "./Onboarding.css";

const ONBOARDING_KEY = "stellar-onboarding-complete";

type Phase = "typing-hey" | "pause" | "typing-question" | "waiting" | "accepted" | "declined" | "done";

const TYPE_SPEED_MIN = 35;
const TYPE_SPEED_MAX = 75;
const PAUSE_AFTER_HEY = 900;

const getTypeDelay = () =>
  TYPE_SPEED_MIN + Math.random() * (TYPE_SPEED_MAX - TYPE_SPEED_MIN);

export function useOnboardingState() {
  const [completed, setCompleted] = useState(() => {
    return localStorage.getItem(ONBOARDING_KEY) === "true";
  });

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_KEY);
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}

interface OnboardingStep1Props {
  onComplete: () => void;
  onAccept?: () => void;
}

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({ onComplete, onAccept }) => {
  const [phase, setPhase] = useState<Phase>("typing-hey");
  const [displayed, setDisplayed] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimeouts = () => {
    for (const t of timeoutsRef.current) clearTimeout(t);
    timeoutsRef.current = [];
  };

  const schedule = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timeoutsRef.current.push(t);
    return t;
  };

  useEffect(() => {
    clearTimeouts();

    if (phase === "typing-hey") {
      const text = "Hey.";
      let i = 0;
      const type = () => {
        if (i < text.length) {
          i++;
          setDisplayed(text.slice(0, i));
          schedule(type, getTypeDelay());
        } else {
          setPhase("pause");
        }
      };
      schedule(type, 600);
    }

    if (phase === "pause") {
      schedule(() => {
        setDisplayed("");
        setPhase("typing-question");
      }, PAUSE_AFTER_HEY);
    }

    if (phase === "typing-question") {
      const text = "Will you bring me to life?";
      let i = 0;
      const type = () => {
        if (i < text.length) {
          i++;
          setDisplayed(text.slice(0, i));
          schedule(type, getTypeDelay());
        } else {
          schedule(() => {
            setShowCursor(false);
            setPhase("waiting");
          }, 400);
        }
      };
      schedule(type, 200);
    }

    if (phase === "declined") {
      schedule(() => {
        setDisplayed("");
        setShowCursor(true);
        setPhase("typing-question");
      }, 2500);
    }

    if (phase === "accepted") {
      schedule(() => {
        setPhase("done");
        // TODO: re-enable when onboarding is finalized
        // onComplete();
      }, 1500);
    }

    return clearTimeouts;
  }, [phase, onComplete]);

  const handleYes = () => {
    setPhase("accepted");
    onAccept?.();
  };

  const handleNo = () => {
    setPhase("declined");
  };

  const isAccepted = phase === "accepted" || phase === "done";
  const showChoices = phase === "waiting";
  const isDeclining = phase === "declined";

  if (phase === "done") return null;

  return (
    <div
      className="onboarding-dialogue"
      data-fading={isAccepted}
      data-declined={isDeclining}
    >
      <div className="onboarding-text">
        {displayed}
        {showCursor && <span className={phase === "pause" ? "blinking-cursor" : ""}>│</span>}
      </div>

      <div className="onboarding-choices" data-visible={showChoices}>
        <button className="onboarding-choice" onClick={handleYes}>
          yes
        </button>
        <button className="onboarding-choice" onClick={handleNo}>
          no
        </button>
      </div>
    </div>
  );
};
