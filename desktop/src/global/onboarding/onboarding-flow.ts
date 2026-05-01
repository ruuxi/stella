import type { DiscoveryCategory } from "@/shared/contracts/discovery";

export type Phase =
  | "intro"
  | "language"
  | "capabilities"
  | "permissions"
  | "extension"
  | "browser"
  | "memory"
  | "creation"
  | "theme"
  | "personality"
  | "shortcuts-global"
  | "shortcuts-local"
  | "double-tap"
  | "voice"
  | "enter"
  | "complete"
  | "done";

export const SPLIT_PHASES = new Set<Phase>([
  "language",
  "capabilities",
  "permissions",
  "browser",
  "extension",
  "theme",
  "personality",
  "creation",
  "shortcuts-global",
  "shortcuts-local",
  "double-tap",
  "voice",
  "memory",
  "enter",
]);

export const SPLIT_STEP_ORDER: Phase[] = [
  "language",
  "capabilities",
  "permissions",
  "browser",
  "extension",
  "theme",
  "personality",
  "creation",
  "shortcuts-global",
  "shortcuts-local",
  "double-tap",
  "voice",
  "memory",
  "enter",
];

/**
 * Discovery rows are translated at render time. `labelKey` /
 * `descriptionKey` resolve against the locale catalog under
 * `onboarding.discovery.<id>.{label,description}`.
 */
export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  labelKey: string;
  descriptionKey: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  {
    id: "apps_system",
    labelKey: "onboarding.discovery.appsSystem.label",
    descriptionKey: "onboarding.discovery.appsSystem.description",
    defaultEnabled: false,
    requiresFDA: true,
  },
  {
    id: "messages_notes",
    labelKey: "onboarding.discovery.messagesNotes.label",
    descriptionKey: "onboarding.discovery.messagesNotes.description",
    defaultEnabled: false,
    requiresFDA: true,
  },
  {
    id: "dev_environment",
    labelKey: "onboarding.discovery.devEnvironment.label",
    descriptionKey: "onboarding.discovery.devEnvironment.description",
    defaultEnabled: false,
    requiresFDA: false,
  },
];

export const BROWSERS = [
  { id: "chrome", label: "Google Chrome" },
  { id: "firefox", label: "Firefox" },
  { id: "edge", label: "Microsoft Edge" },
  { id: "arc", label: "Arc" },
  { id: "brave", label: "Brave" },
  { id: "safari", label: "Safari" },
  { id: "opera", label: "Opera" },
] as const;

export type BrowserId = (typeof BROWSERS)[number]["id"];
