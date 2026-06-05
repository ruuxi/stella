export type OnboardingSynthesisRequest = {
  formattedSections?: Record<string, string>;
  promptConfig?: Record<string, unknown>;
  includeAuth?: boolean;
  includeWelcomeHtml?: boolean;
};

export type OnboardingSynthesisResponse = {
  coreMemory: string;
  welcomeMessage: string;
  welcomeHtml?: string;
  categoryAnalyses?: Record<string, string>;
};

export type OnboardingWelcomeHtmlRequest = {
  coreMemory: string;
  includeAuth?: boolean;
};

export type OnboardingWelcomeHtmlResponse = {
  welcomeHtml: string;
};
