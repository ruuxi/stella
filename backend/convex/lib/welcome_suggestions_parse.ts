import type { HomeSuggestion } from "../prompts/synthesis";
import { extractJsonBlock } from "./json";

const VALID_CATEGORIES = new Set(["stella", "task", "explore", "schedule"]);

const isHomeSuggestion = (value: unknown): value is HomeSuggestion =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as HomeSuggestion).category === "string" &&
  VALID_CATEGORIES.has((value as HomeSuggestion).category) &&
  typeof (value as HomeSuggestion).label === "string" &&
  typeof (value as HomeSuggestion).prompt === "string";

export const parseHomeSuggestionsFromModelText = (
  text: string | undefined,
): HomeSuggestion[] => {
  const raw = text?.trim();
  if (!raw) return [];
  const jsonSlice = extractJsonBlock(raw);
  if (!jsonSlice) return [];
  try {
    const parsed: unknown = JSON.parse(jsonSlice);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHomeSuggestion).slice(0, 20);
  } catch {
    return [];
  }
};
