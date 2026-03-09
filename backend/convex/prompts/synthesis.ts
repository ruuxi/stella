export const buildCoreSynthesisUserMessage = (
  rawOutputs: string,
  promptTemplate: string,
): string => `${promptTemplate}\n\n${rawOutputs}`;

export const buildWelcomeMessagePrompt = (
  coreMemory: string,
  promptTemplate: string,
): string => `${promptTemplate}\n\n${coreMemory}`;

export type WelcomeSuggestion = {
  category: "cron" | "skill" | "app";
  title: string;
  description: string;
  prompt: string;
};

export const buildWelcomeSuggestionsPrompt = (
  coreMemory: string,
  promptTemplate: string,
): string => `${promptTemplate}\n\n${coreMemory}`;
