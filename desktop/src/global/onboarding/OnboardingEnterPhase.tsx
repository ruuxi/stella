import { useEffect, useState } from "react";

type OnboardingEnterPhaseProps = {
  discoveryWelcomeReady: boolean;
  splitTransitionActive: boolean;
  onEnter: () => void;
};

const SUGGESTIONS = [
  "create new apps",
  "work with Excel sheets",
  "build slide decks",
  "draft documents",
  "generate images",
  "control your computer",
  "use your apps for you",
  "work with friends",
  "ship a website",
  "browse the web",
  "remember the things that matter",
  "text you from anywhere",
];

const SUGGESTION_INTERVAL_MS = 2200;

export function OnboardingEnterPhase({
  discoveryWelcomeReady,
  splitTransitionActive,
  onEnter,
}: OnboardingEnterPhaseProps) {
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setSuggestionIndex((v) => (v + 1) % SUGGESTIONS.length);
    }, SUGGESTION_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="onboarding-step-content onboarding-enter-step"
      data-ready={discoveryWelcomeReady || undefined}
    >
      <div className="onboarding-enter-step__status" aria-live="polite">
        {discoveryWelcomeReady ? (
          <span className="onboarding-enter-step__ready">Ready</span>
        ) : (
          <span className="onboarding-enter-step__preparing">
            Preparing
            <span
              className="onboarding-enter-step__dots"
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
            </span>
          </span>
        )}
      </div>

      <div
        className="onboarding-enter-step__suggestion"
        aria-live="off"
      >
        <span className="onboarding-enter-step__suggestion-prefix">
          Stella can
        </span>{" "}
        <span
          key={suggestionIndex}
          className="onboarding-enter-step__suggestion-text"
        >
          {SUGGESTIONS[suggestionIndex]}
        </span>
      </div>

      <button
        className="onboarding-confirm onboarding-enter-step__cta"
        data-visible={discoveryWelcomeReady || undefined}
        disabled={!discoveryWelcomeReady || splitTransitionActive}
        onClick={onEnter}
      >
        Enter Stella
      </button>
    </div>
  );
}
