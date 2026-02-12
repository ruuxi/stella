import { useState, useCallback } from "react";

const ONBOARDING_KEY = "stella-onboarding-complete";

export type Phase =
  | "start"
  | "auth"
  | "intro"
  | "browser"
  | "discovery"
  | "memory"
  | "creation"
  | "phone"
  | "theme"
  | "personality"
  | "complete"
  | "done";

/** Phases that use centered layout (before split) */
export const CENTER_PHASES = new Set<Phase>(["start", "auth", "intro"]);

/** Phases that use split layout */
export const SPLIT_PHASES = new Set<Phase>([
  "browser", "discovery", "memory", "creation", "phone", "theme", "personality",
]);

/** Ordered split steps for navigation */
export const SPLIT_STEP_ORDER: Phase[] = [
  "browser", "discovery", "memory", "creation", "phone", "theme", "personality",
];

export type DiscoveryCategory = "dev_environment" | "apps_system" | "messages_notes";

export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  { id: "dev_environment", label: "Dev Environment", description: "IDE extensions, git config, dotfiles, runtimes", defaultEnabled: true, requiresFDA: false },
  { id: "apps_system", label: "Apps & System", description: "App usage patterns, dock pins, filesystem signals", defaultEnabled: true, requiresFDA: true },
  { id: "messages_notes", label: "Messages & Notes", description: "Communication patterns, note titles, calendar (metadata only)", defaultEnabled: false, requiresFDA: true },
];

export const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

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
