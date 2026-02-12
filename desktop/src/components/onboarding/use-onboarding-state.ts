import { useState, useCallback } from "react";

const ONBOARDING_KEY = "stella-onboarding-complete";

export const PHASES = {
  "start": {
    kind: "start",
  },
  "auth": {
    kind: "auth",
  },
  "ripple-reveal": {
    kind: "ripple",
    next: "theme",
  },
  "theme": {
    kind: "theme",
  },
  "trust": {
    kind: "trust",
  },
  "complete": {
    kind: "complete",
  },
  "done": {
    kind: "done",
  },
} as const;

export type Phase = keyof typeof PHASES;

export type DiscoveryCategory = "browsing_bookmarks" | "dev_environment" | "apps_system" | "messages_notes";

export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  { id: "browsing_bookmarks", label: "Browsing & Bookmarks", description: "Browser history, bookmarks, and saved pages", defaultEnabled: true, requiresFDA: false },
  { id: "dev_environment", label: "Dev Environment", description: "IDE extensions, git config, dotfiles, runtimes", defaultEnabled: true, requiresFDA: false },
  { id: "apps_system", label: "Apps & System", description: "App usage patterns, dock pins, filesystem signals", defaultEnabled: true, requiresFDA: true },
  { id: "messages_notes", label: "Messages & Notes", description: "Communication patterns, note titles, calendar (metadata only)", defaultEnabled: false, requiresFDA: true },
];

export const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

export interface OnboardingStep1Props {
  onComplete: () => void;
  onAccept?: () => void;
  onInteract?: () => void;
  onOpenThemePicker?: () => void;
  onConfirmTheme?: () => void;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
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
