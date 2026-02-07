import { useState, useCallback } from "react";

const ONBOARDING_KEY = "stella-onboarding-complete";

export const TYPE_SPEED_MIN = 35;
export const TYPE_SPEED_MAX = 75;

export const getTypeDelay = () =>
  TYPE_SPEED_MIN + Math.random() * (TYPE_SPEED_MAX - TYPE_SPEED_MIN);

export const PHASES = {
  "typing-intro": {
    kind: "typing",
    text: "Stella is an artificial intelligence assistant for humans.",
    startDelay: 600,
    next: "waiting-click",
  },
  "waiting-click": {
    kind: "click",
    prompt: "sign in to begin",
  },
  "fading-out": {
    kind: "fade",
    next: "typing-preview",
  },
  "typing-preview": {
    kind: "typing",
    text: "As an experimental research preview, Stella can make mistakes but learns, grows, and helps you along the way.",
    startDelay: 200,
    next: "waiting-click-preview",
  },
  "waiting-click-preview": {
    kind: "click",
    prompt: "click",
  },
  "fading-out-preview": {
    kind: "fade",
    next: "typing-question",
  },
  "typing-question": {
    kind: "typing",
    text: "Knowing this, will you bring her to life?",
    startDelay: 200,
    next: "waiting",
  },
  "waiting": {
    kind: "choices",
  },
  "fading-out-question": {
    kind: "fade",
    next: "delay-theme",
  },
  "delay-theme": {
    kind: "delay",
    delayMs: 3000,
    next: "typing-theme",
  },
  "typing-theme": {
    kind: "typing",
    text: "Select Theme",
    startDelay: 200,
    next: "waiting-theme",
  },
  "waiting-theme": {
    kind: "theme",
  },
  "fading-out-theme": {
    kind: "fade",
    next: "typing-discovery",
  },
  "typing-discovery": {
    kind: "typing",
    text: "What should Stella learn about you?",
    startDelay: 200,
    next: "waiting-discovery",
  },
  "waiting-discovery": {
    kind: "discovery",
  },
  "fading-out-discovery": {
    kind: "fade",
    next: "accepted",
  },
  "accepted": {
    kind: "accepted",
  },
  "declined": {
    kind: "declined",
  },
  "done": {
    kind: "done",
  },
} as const;

export type Phase = keyof typeof PHASES;

export const INTRO_PHASES = new Set<Phase>([
  "typing-intro",
  "waiting-click",
  "fading-out",
  "typing-preview",
  "waiting-click-preview",
  "fading-out-preview",
]);

export type DiscoveryCategory = "browsing_bookmarks" | "dev_environment" | "apps_system" | "messages_notes";

export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  { id: "browsing_bookmarks", label: "Browsing & Bookmarks", description: "Browser history, bookmarks, and saved pages", defaultEnabled: true, requiresFDA: false },
  { id: "dev_environment", label: "Development Environment", description: "IDE extensions, git config, dotfiles, runtimes, and package managers", defaultEnabled: true, requiresFDA: false },
  { id: "apps_system", label: "Apps & System", description: "App usage patterns, dock pins, and filesystem signals", defaultEnabled: true, requiresFDA: true },
  { id: "messages_notes", label: "Messages & Notes", description: "Communication patterns, note titles, calendar density (metadata only)", defaultEnabled: false, requiresFDA: true },
];

export const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

export interface OnboardingStep1Props {
  onComplete: () => void;
  onAccept?: () => void;
  onInteract?: () => void;
  onSignIn?: () => void;
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
