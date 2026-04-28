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
