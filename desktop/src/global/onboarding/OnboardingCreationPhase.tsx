import type { CSSProperties, ReactNode } from "react";

export type ShowcaseId =
  | "modern"
  | "cozy-cat"
  | "dj-studio"
  | "weather"
  | "pomodoro";

export type ShowcaseOption = {
  id: ShowcaseId;
  label: string;
  description: string;
  category: string;
  accent: string;
  icon: ReactNode;
};

type CreationPhaseProps = {
  activeShowcase: ShowcaseId | null;
  demoMorphing?: boolean;
  showcaseOptions: ShowcaseOption[];
  splitTransitionActive: boolean;
  onContinue: () => void;
  onSelectShowcase: (id: ShowcaseId) => void;
};

export function OnboardingCreationPhase({
  activeShowcase,
  demoMorphing,
  showcaseOptions,
  splitTransitionActive,
  onContinue,
  onSelectShowcase,
}: CreationPhaseProps) {
  return (
    <div className="onboarding-step-content">
      <p className="onboarding-step-desc">
        Try selecting any of these - each one happens live.
      </p>

      <div
        className="onboarding-showcase-grid"
        style={demoMorphing ? { opacity: 0.5, pointerEvents: "none" } : undefined}
      >
        {showcaseOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className="onboarding-showcase-card"
            style={{ "--showcase-accent": option.accent } as CSSProperties}
            data-active={activeShowcase === option.id}
            onClick={() => onSelectShowcase(option.id)}
          >
            <div className="onboarding-showcase-card-header">
              <div className="onboarding-showcase-card-icon">
                {option.icon}
              </div>
              <span className="onboarding-showcase-card-category">
                {option.category}
              </span>
              <div className="onboarding-showcase-card-indicator" />
            </div>
            <div className="onboarding-showcase-card-title">{option.label}</div>
            <div className="onboarding-showcase-card-desc">
              {option.description}
            </div>
          </button>
        ))}
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
