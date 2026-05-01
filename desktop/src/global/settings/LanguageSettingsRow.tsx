import { useT, useI18n, LOCALE_NATIVE_LABELS, type Locale } from "@/shared/i18n";
import { NativeSelect } from "@/ui/native-select";

/**
 * Settings row for switching the active app language. Stored both in
 * localStorage (instant rendering) and in Convex `user_preferences`
 * (synced across signed-in devices). The native `<select>` keeps the
 * picker accessible and avoids a 27-row dropdown UI from scratch.
 */
export function LanguageSettingsRow() {
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{t("settings.language.title")}</h3>
      <p className="settings-card-desc">{t("settings.language.description")}</p>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">{t("common.language")}</div>
        </div>
        <div className="settings-row-control">
          <NativeSelect
            value={locale}
            onChange={(event) =>
              setLocale(event.currentTarget.value as Locale)
            }
            aria-label={t("common.language")}
          >
            {supportedLocales.map((code) => (
              <option key={code} value={code}>
                {LOCALE_NATIVE_LABELS[code]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
    </div>
  );
}
