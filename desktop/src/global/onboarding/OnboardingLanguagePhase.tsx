import { useI18n, useT, LOCALE_NATIVE_LABELS, type Locale } from "@/shared/i18n";

type LanguagePhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

/**
 * Onboarding's first split-stage phase: pick the app language. Sits
 * before any other selection step so the rest of the flow renders in
 * the chosen language. Picker is a flat list of native-name buttons —
 * 27 entries, scrollable, single-select. Saving the locale is a
 * side-effect of clicking; the caller is responsible for advancing.
 */
export const OnboardingLanguagePhase = ({
  splitTransitionActive,
  onContinue,
}: LanguagePhaseProps) => {
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();

  return (
    <div
      className="onboarding-language-phase"
      data-leaving={splitTransitionActive || undefined}
    >
      <div className="onboarding-language-phase-description">
        {t("onboarding.language.description")}
      </div>
      <div className="onboarding-language-phase-list" role="listbox">
        {supportedLocales.map((code) => (
          <button
            key={code}
            type="button"
            role="option"
            aria-selected={locale === code}
            className="onboarding-language-phase-row"
            data-active={locale === code || undefined}
            onClick={() => setLocale(code as Locale)}
          >
            <span className="onboarding-language-phase-row-native">
              {LOCALE_NATIVE_LABELS[code]}
            </span>
          </button>
        ))}
      </div>
      <div className="onboarding-choices onboarding-choices--subtle" data-visible="true">
        <button
          type="button"
          className="onboarding-choice"
          onClick={onContinue}
        >
          {t("common.continue")}
        </button>
      </div>
    </div>
  );
};
