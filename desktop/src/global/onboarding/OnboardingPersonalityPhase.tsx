type ExpressionStyle = "emotes" | "emoji" | "none" | null;

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
  return (
    <div className="onboarding-step-content">
      <div className="onboarding-pills">
        {(["emotes", "emoji", "none"] as const).map((style) => (
          <button
            key={style}
            className="onboarding-pill"
            data-active={expressionStyle === style}
            onClick={() => onSelectStyle(style)}
          >
            {style.charAt(0).toUpperCase() + style.slice(1)}
          </button>
        ))}
      </div>
      {expressionStyle && (
        <p className="onboarding-personality-preview">
          {expressionStyle === "emotes" && (
            <>
              Got it! I'll get that done for you{" "}
              <img
                src="/emotes/assets/7tv/catNOD-7eeffb97edbf.webp"
                alt="catNOD"
                className="onboarding-emote-preview"
              />
            </>
          )}
          {expressionStyle === "emoji" &&
            "Got it! I'll get that done for you ðŸ˜Š"}
          {expressionStyle === "none" &&
            "Got it. I'll get that done for you."}
        </p>
      )}
      <button
        className="onboarding-confirm"
        data-visible={expressionStyle !== null}
        disabled={splitTransitionActive}
        onClick={onFinish}
      >
        Finish
      </button>
    </div>
  );
}
