export type OnboardingWelcomeSuggestion = {
  category: "cron" | "skill" | "app";
  title: string;
  description: string;
  prompt: string;
};

export type OnboardingSynthesisRequest = {
  formattedSections?: Record<string, string>;
  promptConfig?: Record<string, unknown>;
  includeAuth?: boolean;
};

export type OnboardingSynthesisResponse = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions?: OnboardingWelcomeSuggestion[];
};

