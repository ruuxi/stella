import React, { useState, useEffect, useRef, useCallback } from "react";
import "./Onboarding.css";

const ONBOARDING_KEY = "stellar-onboarding-complete";

type Phase = "typing-intro" | "waiting-click" | "fading-out" | "typing-preview" | "waiting-click-preview" | "fading-out-preview" | "typing-question" | "waiting" | "fading-out-question" | "accepted" | "trust-question" | "waiting-trust" | "declined" | "done";

const TYPE_SPEED_MIN = 35;
const TYPE_SPEED_MAX = 75;

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
  onInteract?: () => void;
  onSignIn?: () => void;
  onTrustConfirm?: (level: "none" | "basic" | "full") => void;
  isAuthenticated?: boolean;
}

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({ onComplete, onAccept, onInteract, onSignIn, onTrustConfirm, isAuthenticated }) => {
  const [phase, setPhase] = useState<Phase>("typing-intro");
  const [displayed, setDisplayed] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const [selectedTrust, setSelectedTrust] = useState<"none" | "basic" | "full" | null>(null);
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

    if (phase === "typing-intro") {
      const text = "Stella is an artificial intelligence assistant for humans.";
      let i = 0;
      const type = () => {
        if (i < text.length) {
          i++;
          setDisplayed(text.slice(0, i));
          schedule(type, getTypeDelay());
        } else {
          schedule(() => {
            setShowCursor(false);
            setPhase("waiting-click");
          }, 400);
        }
      };
      schedule(type, 600);
    }

    if (phase === "fading-out") {
      // Wait for fade animation (0.4s) + pause (0.2s) = 0.6s total
      schedule(() => {
        setDisplayed("");
        setPhase("typing-preview");
      }, 600);
    }

    if (phase === "typing-preview") {
      setShowCursor(true);
      const text = "As an experimental research preview, Stella can make mistakes but learns, grows, and helps you along the way.";
      let i = 0;
      const type = () => {
        if (i < text.length) {
          i++;
          setDisplayed(text.slice(0, i));
          schedule(type, getTypeDelay());
        } else {
          schedule(() => {
            setShowCursor(false);
            setPhase("waiting-click-preview");
          }, 400);
        }
      };
      schedule(type, 200);
    }

    if (phase === "fading-out-preview") {
      schedule(() => {
        setDisplayed("");
        setPhase("typing-question");
      }, 600);
    }

    if (phase === "typing-question") {
      setShowCursor(true);
      const text = "Knowing this, will you bring her to life?";
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

    if (phase === "fading-out-question") {
      // Wait for fade animation (0.4s) + pause (0.2s) = 0.6s total
      schedule(() => {
        setDisplayed("");
        setPhase("accepted");
      }, 600);
    }

    if (phase === "accepted") {
      // Wait 5 seconds after black hole animation starts, then show trust question
      schedule(() => {
        setDisplayed("");
        setPhase("trust-question");
      }, 5000);
    }

    if (phase === "trust-question") {
      setShowCursor(true);
      const text = "How much do you trust me?";
      let i = 0;
      const type = () => {
        if (i < text.length) {
          i++;
          setDisplayed(text.slice(0, i));
          schedule(type, getTypeDelay());
        } else {
          schedule(() => {
            setShowCursor(false);
            setPhase("waiting-trust");
          }, 400);
        }
      };
      schedule(type, 200);
    }

    return clearTimeouts;
  }, [phase, onComplete]);

  // Auto-advance from waiting-click when user signs in
  useEffect(() => {
    if (isAuthenticated && phase === "waiting-click") {
      onInteract?.();
      setPhase("fading-out");
    }
  }, [isAuthenticated, phase, onInteract]);

  const handleClick = () => {
    onInteract?.();
    if (phase === "waiting-click") {
      // Open sign-in dialog instead of advancing directly
      onSignIn?.();
      return;
    } else if (phase === "waiting-click-preview") {
      setPhase("fading-out-preview");
    }
  };

  const handleYes = () => {
    onInteract?.();
    setPhase("fading-out-question");
    onAccept?.();
  };

  const handleNo = () => {
    onInteract?.();
    setPhase("declined");
  };

  const handleTrustSelection = (level: "none" | "basic" | "full") => {
    onInteract?.();
    setSelectedTrust(level);
  };

  const handleTrustConfirm = () => {
    if (!selectedTrust) return;
    onInteract?.();
    onTrustConfirm?.(selectedTrust);
    setPhase("done");
    onComplete();
  };

  const showClickPrompt = phase === "waiting-click" || phase === "waiting-click-preview";
  const isFadingOut = phase === "fading-out" || phase === "fading-out-preview" || phase === "fading-out-question";
  const showChoices = phase === "waiting";
  const showTrustChoices = phase === "waiting-trust";
  const isDeclining = phase === "declined";

  if (phase === "done") return null;

  return (
    <>
      {showClickPrompt && (
        <div 
          className="onboarding-click-overlay" 
          onClick={handleClick}
        />
      )}
      <div
        className="onboarding-dialogue"
        data-fading={isFadingOut}
        data-declined={isDeclining}
        data-phase={phase}
        style={{ display: phase === "accepted" ? "none" : "flex" }}
      >
        <div 
          className="onboarding-text" 
          data-intro={phase === "typing-intro" || phase === "waiting-click" || phase === "fading-out" || phase === "typing-preview" || phase === "waiting-click-preview" || phase === "fading-out-preview"}
          data-trust={phase === "trust-question" || phase === "waiting-trust"}
        >
          {displayed}
          <span className="onboarding-cursor" style={{ opacity: showCursor ? 1 : 0 }}>│</span>
        </div>

        {phase === "waiting-click" && (
          <div className="onboarding-choices onboarding-choices--subtle" data-visible={true}>
            <span className="onboarding-choice">
              sign in to begin
            </span>
          </div>
        )}
        {phase === "waiting-click-preview" && (
          <div className="onboarding-choices onboarding-choices--subtle" data-visible={true}>
            <span className="onboarding-choice">
              click
            </span>
          </div>
        )}

        <div className="onboarding-choices" data-visible={showChoices}>
          <button className="onboarding-choice" onClick={handleYes}>
            yes
          </button>
          <button className="onboarding-choice" onClick={handleNo}>
            no
          </button>
        </div>

        <div className="onboarding-trust-choices" data-visible={showTrustChoices}>
          <button 
            className="onboarding-trust-choice" 
            data-selected={selectedTrust === "none"}
            onClick={() => handleTrustSelection("none")}
          >
            <div className="onboarding-trust-title">Not much right now</div>
            <div className="onboarding-trust-description">Do nothing</div>
          </button>
          <button 
            className="onboarding-trust-choice" 
            data-selected={selectedTrust === "basic"}
            onClick={() => handleTrustSelection("basic")}
          >
            <div className="onboarding-trust-title">I can trust you</div>
            <div className="onboarding-trust-description">I'll learn what I can about you: your name, preferences, and things you like</div>
          </button>
          <button 
            className="onboarding-trust-choice" 
            data-selected={selectedTrust === "full"}
            onClick={() => handleTrustSelection("full")}
          >
            <div className="onboarding-trust-title">I really trust you</div>
            <div className="onboarding-trust-description">I can purchase things and log in for you</div>
          </button>
          <button
            className="onboarding-confirm"
            data-visible={selectedTrust !== null}
            onClick={handleTrustConfirm}
          >
            confirm
          </button>
        </div>
      </div>
    </>
  );
};
