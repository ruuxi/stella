/**
 * Stella's supported locale set. Stored as BCP-47 codes; the renderer
 * surfaces locale names in their native script (`Español`, `日本語`,
 * `العربية`, …) so the picker reads naturally regardless of the user's
 * current language.
 */

export const SUPPORTED_LOCALES = [
  "en",

  // Top European tier
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "ru",

  // CJK
  "ja",
  "zh-Hans",
  "zh-Hant",
  "ko",

  // Remaining European
  "pl",
  "sv",
  "nb",
  "da",
  "fi",
  "cs",
  "el",
  "tr",
  "ro",
  "hu",

  // RTL + South / Southeast Asian
  "ar",
  "hi",
  "id",
  "vi",
  "th",
  "he",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar", "he"]);

/**
 * Display name for each locale, in its own language. Used by the language
 * picker so each option reads natively regardless of which language is
 * currently active.
 */
export const LOCALE_NATIVE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  nl: "Nederlands",
  ru: "Русский",
  ja: "日本語",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ko: "한국어",
  pl: "Polski",
  sv: "Svenska",
  nb: "Norsk bokmål",
  da: "Dansk",
  fi: "Suomi",
  cs: "Čeština",
  el: "Ελληνικά",
  tr: "Türkçe",
  ro: "Română",
  hu: "Magyar",
  ar: "العربية",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  th: "ไทย",
  he: "עברית",
};

/**
 * English-language name for each locale. Used for the response-language
 * directive injected into the assistant system prompt and for English
 * fallback contexts.
 */
export const LOCALE_ENGLISH_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ko: "Korean",
  pl: "Polish",
  sv: "Swedish",
  nb: "Norwegian Bokmål",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  el: "Greek",
  tr: "Turkish",
  ro: "Romanian",
  hu: "Hungarian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  he: "Hebrew",
};

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

export const isSupportedLocale = (
  value: string | null | undefined,
): value is Locale => typeof value === "string" && SUPPORTED_SET.has(value);

/**
 * Match `navigator.language` style tags (`en-US`, `pt-BR`, `zh-CN`, …)
 * down to the closest supported Stella locale. Falls back to the
 * primary subtag and finally to `null` when the language is not
 * supported at all (caller decides the default).
 */
export const matchSupportedLocale = (
  candidate: string | null | undefined,
): Locale | null => {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  if (isSupportedLocale(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();

  // Chinese needs special handling: Hans vs Hant, traditional region tags
  // (zh-CN, zh-SG, zh-MY → Hans; zh-TW, zh-HK, zh-MO → Hant).
  if (lower.startsWith("zh")) {
    if (
      lower.includes("hant") ||
      lower.includes("-tw") ||
      lower.includes("-hk") ||
      lower.includes("-mo")
    ) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }

  // Norwegian Bokmål covers `no` and `nn` for our purposes.
  if (lower === "no" || lower.startsWith("no-") || lower.startsWith("nn")) {
    return "nb";
  }

  const primary = lower.split(/[-_]/)[0];
  if (primary && isSupportedLocale(primary)) return primary;

  return null;
};

/**
 * Resolve the best supported locale from an ordered list of candidates:
 * stored preference, navigator hints, then default. The first match
 * wins.
 */
export const resolveBestLocale = (
  candidates: ReadonlyArray<string | null | undefined>,
): Locale => {
  for (const candidate of candidates) {
    const matched = matchSupportedLocale(candidate ?? null);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
};

export const isRtlLocale = (locale: Locale): boolean =>
  RTL_LOCALES.has(locale);

export const localeDir = (locale: Locale): "ltr" | "rtl" =>
  isRtlLocale(locale) ? "rtl" : "ltr";

/**
 * Stable storage key — only one locale exists per device, regardless of
 * window (full vs mini).
 */
export const LOCALE_STORAGE_KEY = "stella:locale";

/**
 * Convex `user_preferences` key for the locale row. Mirrors the
 * `LOCALE_KEY` constant exported from `backend/convex/data/preferences.ts`.
 */
export const LOCALE_PREFERENCE_KEY = "locale";
