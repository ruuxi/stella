import { useCallback, useEffect, useRef, useState } from "react";

type ThemeSummary = {
  id: string;
  name: string;
};

type ThemePhaseProps = {
  colorMode: "light" | "dark" | "system";
  gradientColor: "relative" | "strong";
  gradientMode: "soft" | "flat";
  sortedThemes: ThemeSummary[];
  splitTransitionActive: boolean;
  themeId: string;
  onContinue: () => void;
  onSelectColorMode: (mode: "light" | "dark" | "system") => void;
  onSelectGradientColor: (color: "relative" | "strong") => void;
  onSelectGradientMode: (mode: "soft" | "flat") => void;
  onSelectTheme: (id: string) => void;
  onThemePreviewEnter: (id: string) => void;
  onThemePreviewLeave: () => void;
};

/** User-friendly display labels for option values */
const DISPLAY_LABELS: Record<string, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const renderThemeOptionRow = <T extends string>(
  label: string,
  options: readonly T[],
  selectedValue: T,
  onSelect: (value: T) => void,
) => (
  <>
    <div className="onboarding-step-label">{label}</div>
    <div className="onboarding-theme-row onboarding-pill-stagger">
      {options.map((option) => (
        <button
          key={option}
          className="onboarding-pill"
          data-active={selectedValue === option}
          onClick={() => onSelect(option)}
        >
          {DISPLAY_LABELS[option] ?? option.charAt(0).toUpperCase() + option.slice(1)}
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
  const [showAppearance, setShowAppearance] = useState(false);
  const [showGradientStyle, setShowGradientStyle] = useState(false);
  const [showGradientColor, setShowGradientColor] = useState(false);
  const [hasSelectedGradientColor, setHasSelectedGradientColor] = useState(false);

  // rAF-coalesce theme preview hover. `previewTheme(id)` writes CSS
  // variables on `:root` and triggers a full-tree style recalc; sweeping
  // the cursor across the pill row would otherwise fire one such
  // recalc per `mouseenter` (potentially several per frame). We commit
  // only the latest hovered theme on the next animation frame.
  const previewFrameRef = useRef<number | null>(null);
  const pendingPreviewIdRef = useRef<string | null>(null);
  const handleThemePreviewEnter = useCallback(
    (id: string) => {
      pendingPreviewIdRef.current = id;
      if (previewFrameRef.current !== null) return;
      previewFrameRef.current = requestAnimationFrame(() => {
        previewFrameRef.current = null;
        const next = pendingPreviewIdRef.current;
        if (next !== null) onThemePreviewEnter(next);
      });
    },
    [onThemePreviewEnter],
  );
  const handleThemePreviewLeave = useCallback(() => {
    pendingPreviewIdRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    onThemePreviewLeave();
  }, [onThemePreviewLeave]);
  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    },
    [],
  );

  const handleSelectTheme = useCallback(
    (id: string) => {
      onSelectTheme(id);
      setShowAppearance(true);
    },
    [onSelectTheme],
  );

  const handleSelectColorMode = useCallback(
    (mode: "light" | "dark" | "system") => {
      onSelectColorMode(mode);
      setShowGradientStyle(true);
    },
    [onSelectColorMode],
  );

  const handleSelectGradientMode = useCallback(
    (mode: "soft" | "flat") => {
      onSelectGradientMode(mode);
      setShowGradientColor(true);
    },
    [onSelectGradientMode],
  );

  const handleSelectGradientColor = useCallback(
    (color: "relative" | "strong") => {
      onSelectGradientColor(color);
      setHasSelectedGradientColor(true);
    },
    [onSelectGradientColor],
  );

  const canContinue =
    showAppearance && showGradientStyle && showGradientColor && hasSelectedGradientColor;

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">Theme</div>
      <div
        className="onboarding-theme-grid onboarding-pill-stagger"
        onMouseLeave={handleThemePreviewLeave}
      >
        {sortedThemes.map((theme) => (
          <button
            key={theme.id}
            className="onboarding-pill"
            data-active={theme.id === themeId}
            onClick={() => handleSelectTheme(theme.id)}
            onMouseEnter={() => handleThemePreviewEnter(theme.id)}
          >
            {theme.name}
          </button>
        ))}
      </div>

      <div className="onboarding-theme-reveal" data-visible={showAppearance || undefined}>
        <div className="onboarding-theme-reveal-inner">
          {renderThemeOptionRow(
            "Appearance",
            ["light", "dark", "system"] as const,
            colorMode,
            handleSelectColorMode,
          )}
        </div>
      </div>

      <div className="onboarding-theme-reveal" data-visible={showGradientStyle || undefined}>
        <div className="onboarding-theme-reveal-inner">
          {renderThemeOptionRow(
            "Gradient Style",
            ["soft", "flat"] as const,
            gradientMode,
            handleSelectGradientMode,
          )}
        </div>
      </div>

      <div className="onboarding-theme-reveal" data-visible={showGradientColor || undefined}>
        <div className="onboarding-theme-reveal-inner">
          {renderThemeOptionRow(
            "Gradient Color",
            ["relative", "strong"] as const,
            gradientColor,
            handleSelectGradientColor,
          )}
        </div>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={canContinue || undefined}
        disabled={splitTransitionActive || !canContinue}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
