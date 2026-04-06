import { useState } from "react";

type ExpressionStyle = "emotes" | "emoji" | "none" | null;
const EMOTE_PREVIEW_SRC = "/emotes/assets/7tv/Agreeing-6db2604d601b.webp";

type PersonalityPhaseProps = {
  expressionStyle: ExpressionStyle;
  splitTransitionActive: boolean;
  onFinish: () => void;
  onSelectStyle: (style: Exclude<ExpressionStyle, null>) => void;
};

export function OnboardingPersonalityPhase({
  expressionStyle,
  splitTransitionActive,
  onFinish,
  onSelectStyle,
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
