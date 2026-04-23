import { useState } from "react";

type ExpressionStyle = "emotes" | "emoji" | "none" | null;
const EMOTE_PREVIEW_SRC = "/emotes/assets/7tv/Agreeing-6db2604d601b.webp";

type PersonalityPhaseProps = {
  expressionStyle: ExpressionStyle;
  splitTransitionActive: boolean;
  showEyes: boolean;
  showMouth: boolean;
  onFinish: () => void;
  onSelectStyle: (style: Exclude<ExpressionStyle, null>) => void;
  onToggleEyes: () => void;
  onToggleMouth: () => void;
};

export function OnboardingPersonalityPhase({
  expressionStyle,
  splitTransitionActive,
  showEyes,
  showMouth,
  onFinish,
  onSelectStyle,
  onToggleEyes,
  onToggleMouth,
}: PersonalityPhaseProps) {
  const [emotePreviewUnavailable, setEmotePreviewUnavailable] = useState(false);
  const handleSelectStyle = (style: Exclude<ExpressionStyle, null>) => {
    if (style === "emotes") {
      setEmotePreviewUnavailable(false);
    }
    onSelectStyle(style);
  };

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-pills onboarding-pill-stagger">
        {(["emotes", "emoji", "none"] as const).map((style) => (
          <button
            key={style}
            className="onboarding-pill"
            data-active={expressionStyle === style}
            onClick={() => handleSelectStyle(style)}
          >
            {style.charAt(0).toUpperCase() + style.slice(1)}
          </button>
        ))}
      </div>
      <p
        className="onboarding-personality-preview"
        data-visible={expressionStyle !== null || undefined}
        aria-hidden={expressionStyle === null}
      >
        {expressionStyle === "emotes" && (
          <>
            Got it! I'll get that done for you{" "}
            {emotePreviewUnavailable ? (
              <span aria-hidden="true">😊</span>
            ) : (
              <img
                src={EMOTE_PREVIEW_SRC}
                alt="Agreeing"
                className="onboarding-emote-preview"
                onError={() => setEmotePreviewUnavailable(true)}
              />
            )}
          </>
        )}
        {expressionStyle === "emoji" &&
          "Got it! I'll get that done for you \uD83D\uDE0A"}
        {expressionStyle === "none" && "Got it. I'll get that done for you."}
      </p>

      <div className="onboarding-look-section">
        <div className="onboarding-step-label">How should I look?</div>
        <div className="onboarding-pills onboarding-pill-stagger">
          <button
            type="button"
            className="onboarding-pill"
            data-active={showEyes}
            aria-pressed={showEyes}
            onClick={onToggleEyes}
          >
            Eyes
          </button>
          <button
            type="button"
            className="onboarding-pill"
            data-active={showMouth}
            aria-pressed={showMouth}
            onClick={onToggleMouth}
          >
            Mouth
          </button>
        </div>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={expressionStyle !== null}
        disabled={splitTransitionActive}
        onClick={onFinish}
      >
        Continue
      </button>
    </div>
  );
}
