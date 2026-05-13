import { useMemo } from "react";
import { useT, useI18n, LOCALE_NATIVE_LABELS, type Locale } from "@/shared/i18n";
import { Select } from "@/ui/select";

/**
 * Settings row for switching the active app language. Stored both in
 * localStorage (instant rendering) and in Convex `user_preferences`
 * (synced across signed-in devices).
 */
export function LanguageSettingsRow() {
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();
  const localeOptions = useMemo(
    () =>
      supportedLocales.map((code) => ({
        value: code,
        label: LOCALE_NATIVE_LABELS[code],
      })),
    [supportedLocales],
  );

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{t("settings.language.title")}</h3>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">{t("common.language")}</div>
        </div>
        <div className="settings-row-control">
          <Select<Locale>
            className="settings-runtime-select"
            value={locale}
            onValueChange={(next) => setLocale(next)}
            options={localeOptions}
            aria-label={t("common.language")}
          />
        </div>
      </div>
    </div>
  );
}
