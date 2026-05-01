export type OnboardingHomeSuggestion = {
  category: "stella" | "task" | "explore" | "schedule";
  label: string;
  prompt: string;
};

/**
 * Icon vocabulary the welcome-flow app-recommendation generator may pick from.
 * Kept narrow so the renderer can render a stable lucide glyph per badge
 * without parsing free-form text. Anything outside this set falls back to
 * the generic info glyph.
 */
export type OnboardingAppBadgeIcon =
  | "browser"
  | "key"
  | "account"
  | "info";

export type OnboardingAppBadge = {
  icon: OnboardingAppBadgeIcon;
  label: string;
};

/**
 * Personalized app the LLM thinks Stella should build for this user, based
 * on their core memory. Surfaced in the post-welcome dialog as a one-shot
 * "want me to build this?" prompt — clicking dispatches the `prompt` to the
 * orchestrator. `badges` describe upfront requirements (browser sign-in,
 * needs an API key, etc.) so the user understands what they're consenting
 * to before kicking it off.
 */
export type OnboardingAppRecommendation = {
  label: string;
  description: string;
  prompt: string;
  badges: OnboardingAppBadge[];
};

export type OnboardingSynthesisRequest = {
  formattedSections?: Record<string, string>;
  promptConfig?: Record<string, unknown>;
  includeAuth?: boolean;
};

export type OnboardingSynthesisResponse = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions?: OnboardingHomeSuggestion[];
  appRecommendations?: OnboardingAppRecommendation[];
  categoryAnalyses?: Record<string, string>;
};

