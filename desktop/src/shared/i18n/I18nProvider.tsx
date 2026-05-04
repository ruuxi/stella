import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  type Catalog,
  getEagerCatalog,
  loadCatalog,
  translate,
  translateArray,
  type TranslateParams,
} from "./catalogs";
import {
  DEFAULT_LOCALE,
  isRtlLocale,
  isSupportedLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  localeDir,
  resolveBestLocale,
  SUPPORTED_LOCALES,
} from "./locales";

type I18nContextValue = {
  /** Currently active locale (BCP-47). */
  locale: Locale;
  /** True when the active locale renders right-to-left. */
  isRTL: boolean;
  /**
   * Update the locale. Persists to localStorage immediately and, when
   * the user is signed in, fan out to Convex `user_preferences` so it
   * follows them across devices.
   */
  setLocale: (locale: Locale) => void;
  /**
   * Translate a dotted key (e.g. `settings.tabs.basic`) against the
   * active catalog. Falls back to English, then the raw key.
   */
  t: (key: string, params?: TranslateParams) => string;
  /**
   * Resolve an array-valued key (e.g. plan feature lists). Falls back to
   * English, then an empty array.
   */
  tArray: (key: string, params?: TranslateParams) => string[];
  /** All supported locales — handy for picker rendering. */
  supportedLocales: ReadonlyArray<Locale>;
};

const I18nContext = createContext<I18nContextValue | null>(null);

const readPersistedLocale = (): Locale | null => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : null;
  } catch {
    return null;
  }
};

const writePersistedLocale = (locale: Locale) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* localStorage can throw in private mode — non-critical. */
  }
};

const navigatorLanguages = (): string[] => {
  if (typeof navigator === "undefined") return [];
  const list: string[] = [];
  const languages = navigator.languages;
  if (Array.isArray(languages)) {
    list.push(...languages);
  }
  if (typeof navigator.language === "string") {
    list.push(navigator.language);
  }
  return list;
};

const initialLocale = (): Locale =>
  resolveBestLocale([readPersistedLocale(), ...navigatorLanguages()]);

const applyDocumentLocale = (locale: Locale) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", locale);
  root.setAttribute("dir", localeDir(locale));
  root.dataset.stellaLocale = locale;
  root.dataset.stellaTextDir = localeDir(locale);
};

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [catalog, setCatalog] = useState<Catalog | undefined>(() =>
    getEagerCatalog(locale),
  );

  // Keep <html lang/dir> in lockstep with the active locale so platform
  // affordances (form inputs, native context menus, browser hyphenation)
  // pick up the right script direction.
  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  // Lazily fetch the active locale's JSON. English is bundled eagerly.
  useEffect(() => {
    let cancelled = false;
    void loadCatalog(locale).then((next) => {
      if (cancelled) return;
      setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // Stay in sync across windows (mini ↔ full chat) on the same device.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY || !event.newValue) return;
      if (!isSupportedLocale(event.newValue)) return;
      if (event.newValue === locale) return;
      setLocaleState(event.newValue);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [locale]);

  // Pull the user's stored locale from Convex when signed in. Treats
  // the renderer-local localStorage value as an instant cache, then
  // upgrades once the server replies. The Convex query is the
  // external state we're syncing with — setting state in this effect
  // is exactly the "subscribe + setState" shape the lint rule
  // exempts.
  const remotePreference = useQuery(api.data.preferences.getLocale, {});
  useEffect(() => {
    if (remotePreference === undefined) return;
    if (!remotePreference) return;
    if (!isSupportedLocale(remotePreference)) return;
    if (remotePreference === locale) return;
    setLocaleState(remotePreference);
    writePersistedLocale(remotePreference);
  }, [remotePreference, locale]);

  const saveRemoteLocale = useMutation(api.data.preferences.setLocale);

  const setLocale = useCallback(
    (next: Locale) => {
      if (!isSupportedLocale(next)) return;
      setLocaleState(next);
      writePersistedLocale(next);
      // Best-effort sync to Convex; signed-out users just keep the
      // localStorage value.
      void saveRemoteLocale({ locale: next }).catch(() => {
        /* signed-out / network — preference still lives locally */
      });
    },
    [saveRemoteLocale],
  );

  const t = useCallback(
    (key: string, params?: TranslateParams) => translate(catalog, key, params),
    [catalog],
  );

  const tArray = useCallback(
    (key: string, params?: TranslateParams) =>
      translateArray(catalog, key, params),
    [catalog],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      isRTL: isRtlLocale(locale),
      setLocale,
      t,
      tArray,
      supportedLocales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale, t, tArray],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside an <I18nProvider>");
  }
  return ctx;
}

export function useT() {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

const FALLBACK: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  isRTL: false,
  setLocale: () => {
    /* no-op — provider missing */
  },
  t: (key, params) => translate(getEagerCatalog(DEFAULT_LOCALE), key, params),
  tArray: (key, params) =>
    translateArray(getEagerCatalog(DEFAULT_LOCALE), key, params),
  supportedLocales: SUPPORTED_LOCALES,
};

/**
 * Static accessor for environments without a React tree (e.g. tests,
 * non-React modules). Always reads from the English fallback catalog.
 */
export const i18nFallback = FALLBACK;
