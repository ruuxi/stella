export type OnboardingHomeSuggestion = {
  category: "stella" | "task" | "explore" | "schedule";
  label: string;
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
  suggestions?: OnboardingHomeSuggestion[];
};

