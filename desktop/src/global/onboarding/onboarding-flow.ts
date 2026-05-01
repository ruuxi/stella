import type { DiscoveryCategory } from "@/shared/contracts/discovery";

export type Phase =
  | "intro"
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

export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  {
    id: "apps_system",
    label: "Your apps and computer",
    description:
      "Which apps you use most, how your desktop is organized, and your workflow",
    defaultEnabled: false,
    requiresFDA: true,
  },
  {
    id: "messages_notes",
    label: "Your notes and calendar",
    description:
      "What you're working on, your schedule, and how you organize your thoughts",
    defaultEnabled: false,
    requiresFDA: true,
  },
  {
    id: "dev_environment",
    label: "Your coding setup",
    description:
      "Tools you use, projects you work on, and how your environment is configured",
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
