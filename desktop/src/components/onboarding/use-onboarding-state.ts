import { useState, useCallback } from "react";

const ONBOARDING_KEY = "stella-onboarding-complete";

export type Phase =
  | "start"
  | "auth"
  | "intro"
  | "browser"
  | "memory"
  | "creation"
  | "theme"
  | "personality"
  | "shortcuts"
  | "complete"
  | "done";

/** Phases that use centered layout (before split) */
export const CENTER_PHASES = new Set<Phase>(["start", "auth", "intro"]);

/** Phases that use split layout */
export const SPLIT_PHASES = new Set<Phase>([
  "browser", "memory", "creation", "theme", "personality", "shortcuts",
]);

/** Ordered split steps for navigation */
export const SPLIT_STEP_ORDER: Phase[] = [
  "browser", "memory", "creation", "theme", "personality", "shortcuts",
];

export type DiscoveryCategory = "dev_environment" | "apps_system" | "messages_notes";

export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  { id: "apps_system", label: "Your apps and computer", description: "Which apps you use most, how your desktop is organized, and your workflow", defaultEnabled: false, requiresFDA: true },
  { id: "messages_notes", label: "Your notes and calendar", description: "What you're working on, your schedule, and how you organize your thoughts", defaultEnabled: false, requiresFDA: true },
  { id: "dev_environment", label: "Your coding setup", description: "Tools you use, projects you work on, and how your environment is configured", defaultEnabled: false, requiresFDA: false },
];

export const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";
export const BROWSER_SELECTION_KEY = "stella-selected-browser";
export const BROWSER_PROFILE_KEY = "stella-selected-browser-profile";

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

export interface OnboardingStep1Props {
  onComplete: () => void;
  onAccept?: () => void;
  onInteract?: () => void;
  onOpenThemePicker?: () => void;
  onConfirmTheme?: () => void;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onEnterSplit?: () => void;
  onDemoChange?: (demo: "dj-studio" | "weather-station" | null) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  themeConfirmed?: boolean;
  hasSelectedTheme?: boolean;
  isAuthenticated?: boolean;
}

export function useOnboardingState() {
  const [completed, setCompleted] = useState(() => {
    return localStorage.getItem(ONBOARDING_KEY) === "true";
  });

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_KEY);
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}
