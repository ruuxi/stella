type ThemeSummary = {
  id: string;
  name: string;
};

type ThemePhaseProps = {
  colorMode: "light" | "dark" | "system";
  gradientColor: "relative" | "strong";
  gradientMode: "soft" | "crisp";
  sortedThemes: ThemeSummary[];
  splitTransitionActive: boolean;
  themeId: string;
  onContinue: () => void;
  onSelectColorMode: (mode: "light" | "dark" | "system") => void;
  onSelectGradientColor: (color: "relative" | "strong") => void;
  onSelectGradientMode: (mode: "soft" | "crisp") => void;
  onSelectTheme: (id: string) => void;
  onThemePreviewEnter: (id: string) => void;
  onThemePreviewLeave: () => void;
};

const renderThemeOptionRow = <T extends string>(
  label: string,
  options: readonly T[],
  selectedValue: T,
  onSelect: (value: T) => void,
) => (
  <>
    <div className="onboarding-step-label">{label}</div>
    <div className="onboarding-theme-row">
      {options.map((option) => (
        <button
          key={option}
          className="onboarding-pill"
          data-active={selectedValue === option}
          onClick={() => onSelect(option)}
        >
          {option.charAt(0).toUpperCase() + option.slice(1)}
        </button>
      ))}
    </div>
  </>
);

export function OnboardingThemePhase({
  colorMode,
  gradientColor,
  gradientMode,
  sortedThemes,
  splitTransitionActive,
  themeId,
  onContinue,
  onSelectColorMode,
  onSelectGradientColor,
  onSelectGradientMode,
  onSelectTheme,
  onThemePreviewEnter,
  onThemePreviewLeave,
}: ThemePhaseProps) {
  return (
    <div className="onboarding-step-content">
      {renderThemeOptionRow(
        "Appearance",
        ["light", "dark", "system"] as const,
        colorMode,
        onSelectColorMode,
      )}

      {renderThemeOptionRow(
        "Background",
        ["soft", "crisp"] as const,
        gradientMode,
        onSelectGradientMode,
      )}

      {renderThemeOptionRow(
        "Color intensity",
        ["relative", "strong"] as const,
        gradientColor,
        onSelectGradientColor,
      )}

      <div className="onboarding-step-label">Theme</div>
      <div
        className="onboarding-theme-grid"
        onMouseLeave={onThemePreviewLeave}
      >
        {sortedThemes.map((theme) => (
          <button
            key={theme.id}
            className="onboarding-pill"
            data-active={theme.id === themeId}
            onClick={() => onSelectTheme(theme.id)}
            onMouseEnter={() => onThemePreviewEnter(theme.id)}
          >
            {theme.name}
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
