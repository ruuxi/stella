/**
 * Translation catalogs are JSON files keyed by locale. English (`en`) is
 * always bundled eagerly so the renderer has an immediate fallback even
 * before the active locale resolves; every other locale is loaded
 * lazily so we don't ship 27 catalogs in the initial bundle when the
 * user only ever sees one of them.
 *
 * Catalogs are nested objects:
 *
 *   { common: { continue: "Continue" }, settings: { tabs: { basic: "Basic" } } }
 *
 * `t("settings.tabs.basic")` walks the dot-notation path inside the
 * active catalog and falls back to the English catalog (and finally the
 * raw key) if the path is missing. Keep keys descriptive — they're the
 * developer-facing source of truth even when English copy ships untranslated.
 */

import { DEFAULT_LOCALE, type Locale } from "./locales";
import enCatalog from "./locales/en.json";

export type Catalog = Record<string, unknown>;

const EAGER: Record<Locale, Catalog | undefined> = {
  en: enCatalog as Catalog,
} as Record<Locale, Catalog | undefined>;

const LAZY_LOADERS = import.meta.glob<{ default: Catalog }>(
  "./locales/*.json",
);

const loaderForLocale = (locale: Locale) =>
  LAZY_LOADERS[`./locales/${locale}.json`];

const loadCache = new Map<Locale, Promise<Catalog>>();

export const loadCatalog = (locale: Locale): Promise<Catalog> => {
  const eager = EAGER[locale];
  if (eager) return Promise.resolve(eager);

  const cached = loadCache.get(locale);
  if (cached) return cached;

  const loader = loaderForLocale(locale);
  if (!loader) {
    return Promise.resolve(EAGER.en ?? {});
  }

  const promise = loader()
    .then((mod) => mod.default ?? {})
    .catch(() => EAGER.en ?? {});
  loadCache.set(locale, promise);
  return promise;
};

export const getEagerCatalog = (locale: Locale): Catalog | undefined =>
  EAGER[locale];

const lookupPath = (catalog: Catalog | undefined, key: string): unknown => {
  if (!catalog) return undefined;
  let cursor: unknown = catalog;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
};

export type TranslateParams = Record<string, string | number>;

const interpolate = (template: string, params: TranslateParams): string =>
  template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });

/**
 * Resolve `key` against `catalog` first, then English, then the key
 * itself. Interpolates `{name}` placeholders with `params`.
 */
export const translate = (
  catalog: Catalog | undefined,
  key: string,
  params?: TranslateParams,
): string => {
  const value = lookupPath(catalog, key);
  if (typeof value === "string") {
    return params ? interpolate(value, params) : value;
  }
  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
    if (typeof fallback === "string") {
      return params ? interpolate(fallback, params) : fallback;
    }
  }
  return key;
};

/**
 * Resolve a key whose value is an array of strings (e.g. plan feature
 * lists). Falls back to English when the active catalog hasn't translated
 * the array yet.
 */
export const translateArray = (
  catalog: Catalog | undefined,
  key: string,
  params?: TranslateParams,
): string[] => {
  const value = lookupPath(catalog, key);
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => (params ? interpolate(item, params) : item));
  }
  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
    if (Array.isArray(fallback)) {
      return fallback
        .filter((item): item is string => typeof item === "string")
        .map((item) => (params ? interpolate(item, params) : item));
    }
  }
  return [];
};
