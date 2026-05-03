import type { PersonalityVoice } from "../../../../runtime/extensions/stella-runtime/personality/voices.js";

type PersonalityPhaseProps = {
  personalityVoices: readonly PersonalityVoice[];
  personalityVoiceId: string | null;
  defaultPersonalityVoiceId: string;
  splitTransitionActive: boolean;
  onFinish: () => void;
  onSelectVoice: (voiceId: string) => void;
};

export function OnboardingPersonalityPhase({
  personalityVoices,
  personalityVoiceId,
  defaultPersonalityVoiceId,
  splitTransitionActive,
  onFinish,
  onSelectVoice,
}: PersonalityPhaseProps) {
  const activeVoiceId = personalityVoiceId ?? null;
  const activeVoice =
    personalityVoices.find((voice) => voice.id === activeVoiceId) ??
    personalityVoices.find(
      (voice) => voice.id === defaultPersonalityVoiceId,
    ) ??
    null;

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-pills onboarding-pill-stagger">
        {personalityVoices.map((voice) => (
          <button
            key={voice.id}
            type="button"
            className="onboarding-pill"
            data-active={activeVoiceId === voice.id}
            onClick={() => onSelectVoice(voice.id)}
          >
            {voice.label}
          </button>
        ))}
      </div>

      <p
        className="onboarding-voice-description"
        data-visible={activeVoiceId !== null || undefined}
        aria-hidden={activeVoiceId === null}
      >
        {activeVoice ? activeVoice.description : ""}
      </p>

      <p
        className="onboarding-personality-preview"
        data-visible={activeVoiceId !== null || undefined}
        aria-hidden={activeVoiceId === null}
      >
        {activeVoice ? activeVoice.sampleLine : ""}
      </p>

      <button
        className="onboarding-confirm"
        data-visible={activeVoiceId !== null}
        disabled={splitTransitionActive}
        onClick={onFinish}
      >
        Continue
      </button>
    </div>
  );
}
