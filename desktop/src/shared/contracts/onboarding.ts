export type OnboardingSynthesisRequest = {
  formattedSections?: Record<string, string>;
  promptConfig?: Record<string, unknown>;
  includeAuth?: boolean;
};

export type OnboardingSynthesisResponse = {
  coreMemory: string;
  welcomeMessage: string;
  categoryAnalyses?: Record<string, string>;
};
