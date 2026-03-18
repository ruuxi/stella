const CATEGORY_LABELS: Record<string, string> = {
  browsing_bookmarks: "Browsing & Bookmarks",
  dev_environment: "Development Environment",
  apps_system: "Apps & System",
  messages_notes: "Messages & Notes",
};

export const buildCategoryAnalysisUserMessage = (
  category: string,
  data: string,
  promptTemplate: string,
): string => {
  const categoryLabel = CATEGORY_LABELS[category] ?? category;
  return promptTemplate
    .replace("{{categoryLabel}}", categoryLabel)
    .replace("{{data}}", data);
};

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
