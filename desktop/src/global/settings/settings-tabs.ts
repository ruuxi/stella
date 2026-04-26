export const SETTINGS_TAB_KEYS = [
  "basic",
  "memory",
  "backup",
  "account",
  "models",
  "audio",
] as const;

export type SettingsTab = (typeof SETTINGS_TAB_KEYS)[number];

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "basic", label: "Basic" },
  { key: "memory", label: "Memory" },
  { key: "backup", label: "Backups" },
  { key: "account", label: "Account & Legal" },
  { key: "models", label: "Models" },
  { key: "audio", label: "Audio" },
];
