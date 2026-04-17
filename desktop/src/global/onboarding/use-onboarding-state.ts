import { useCallback, useEffect, useState } from "react";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";

export const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";

export type Phase =
  | "start"
  | "auth"
  | "intro"
  | "permissions"
  | "browser"
  | "memory"
  | "creation"
  | "theme"
  | "personality"
  | "shortcuts-global"
  | "shortcuts-local"
  | "complete"
  | "done";

/** Phases that use centered layout (before split) */
export const CENTER_PHASES = new Set<Phase>(["start", "auth", "intro"]);

/** Phases that use split layout */
export const SPLIT_PHASES = new Set<Phase>([
  "permissions", "browser", "creation", "theme", "personality", "shortcuts-global", "shortcuts-local",
]);

/** Ordered split steps for navigation */
export const SPLIT_STEP_ORDER: Phase[] = [
  "permissions", "browser", "creation", "theme", "personality", "shortcuts-global", "shortcuts-local",
];

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
  initialPhase?: Phase;
  onOpenThemePicker?: () => void;
  onConfirmTheme?: () => void;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onEnterSplit?: () => void;
  onDemoChange?: (demo: "default" | null) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  themeConfirmed?: boolean;
  hasSelectedTheme?: boolean;
  isAuthenticated?: boolean;
}

const readOnboardingCompleted = () => {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
};

export function useOnboardingState() {
  const [completed, setCompleted] = useState(() => {
    return readOnboardingCompleted();
  });

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key !== ONBOARDING_COMPLETE_KEY) return;
      setCompleted(event.newValue === "true");
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}
