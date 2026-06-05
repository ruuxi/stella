import type {
  PersonalityId,
  PersonalityOption,
} from "../../../../runtime/contracts/personality.js";

type PersonalityPhaseProps = {
  personalityOptions: readonly PersonalityOption[];
  personalityVoiceId: PersonalityId | null;
  defaultPersonalityVoiceId: PersonalityId;
  splitTransitionActive: boolean;
  onFinish: () => void;
  onSelectVoice: (voiceId: PersonalityId) => void;
};

export function OnboardingPersonalityPhase({
  personalityOptions,
  personalityVoiceId,
  defaultPersonalityVoiceId,
  splitTransitionActive,
  onFinish,
  onSelectVoice,
}: PersonalityPhaseProps) {
  const activeId = personalityVoiceId ?? defaultPersonalityVoiceId;
  const activeOption =
    personalityOptions.find((option) => option.id === activeId) ?? null;

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-pills onboarding-pill-stagger">
        {personalityOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className="onboarding-pill"
            data-active={activeId === option.id}
            onClick={() => onSelectVoice(option.id)}
          >
            {option.id === defaultPersonalityVoiceId
              ? `${option.label} (default)`
              : option.label}
          </button>
        ))}
      </div>

      <p className="onboarding-voice-description" data-visible>
        {activeOption ? activeOption.description : ""}
      </p>

      <button
        className="onboarding-confirm"
        data-visible
        disabled={splitTransitionActive}
        onClick={onFinish}
      >
        Continue
      </button>
    </div>
  );
}
