type CreationPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

export function OnboardingCreationPhase({
  splitTransitionActive,
  onContinue,
}: CreationPhaseProps) {
  return (
    <div className="onboarding-step-content onboarding-step-content--creation">
      <p className="onboarding-step-desc">
        Click any pill on the demo above to transform that part of me. Mix and
        match — every change happens live.
      </p>

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
