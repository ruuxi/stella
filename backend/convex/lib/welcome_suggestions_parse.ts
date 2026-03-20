import type { WelcomeSuggestion } from "../prompts/synthesis";
import { extractJsonBlock } from "./json";

const isWelcomeSuggestion = (value: unknown): value is WelcomeSuggestion =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WelcomeSuggestion).category === "string" &&
  typeof (value as WelcomeSuggestion).title === "string" &&
  typeof (value as WelcomeSuggestion).prompt === "string";

export const parseWelcomeSuggestionsFromModelText = (
  text: string | undefined,
): WelcomeSuggestion[] => {
  const raw = text?.trim();
  if (!raw) return [];
  const jsonSlice = extractJsonBlock(raw);
  if (!jsonSlice) return [];
  try {
    const parsed: unknown = JSON.parse(jsonSlice);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWelcomeSuggestion).slice(0, 5);
  } catch {
    return [];
  }
};
