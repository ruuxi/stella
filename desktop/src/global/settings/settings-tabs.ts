export const SETTINGS_TAB_KEYS = [
  "basic",
  "shortcuts",
  "memory",
  "backup",
  "account",
  "models",
  "audio",
] as const;

export type SettingsTab = (typeof SETTINGS_TAB_KEYS)[number];

/**
 * Tabs are translated at render time via `t("settings.tabs.<key>")` —
 * the source of truth lives in the locale catalogs under
 * `desktop/src/shared/i18n/locales/`. Each entry exposes its i18n key
 * (`labelKey`) so callers don't need to know the catalog layout.
 */
export const SETTINGS_TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "basic", labelKey: "settings.tabs.basic" },
  { key: "shortcuts", labelKey: "settings.tabs.shortcuts" },
  { key: "memory", labelKey: "settings.tabs.memory" },
  { key: "backup", labelKey: "settings.tabs.backup" },
  { key: "account", labelKey: "settings.tabs.account" },
  { key: "models", labelKey: "settings.tabs.models" },
  { key: "audio", labelKey: "settings.tabs.audio" },
];
