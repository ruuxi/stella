import type {
  AppBadgeIcon,
  AppRecommendation,
  AppRecommendationBadge,
  HomeSuggestion,
} from "../prompts/synthesis";
import { extractJsonBlock } from "./json";

const VALID_CATEGORIES = new Set(["stella", "task", "explore", "schedule"]);
const VALID_BADGE_ICONS = new Set<AppBadgeIcon>([
  "browser",
  "account",
  "key",
  "info",
]);

function stripMarkdownFences(text: string): string {
  const s = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) {
    return fenced[1].trim();
  }
  return s;
}

function coerceToSuggestionArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const keys = ["suggestions", "suggestion", "items", "homeSuggestions"] as const;
    for (const k of keys) {
      const v = o[k];
      if (Array.isArray(v)) {
        return v;
      }
    }
    const vals = Object.values(o);
    if (vals.length === 1 && Array.isArray(vals[0])) {
      return vals[0];
    }
  }
  return [];
}

function normalizeCategory(
  cat: unknown,
): HomeSuggestion["category"] | null {
  if (typeof cat !== "string") {
    return null;
  }
  const c = cat.toLowerCase().trim();
  if (VALID_CATEGORIES.has(c)) {
    return c as HomeSuggestion["category"];
  }
  return null;
}

function normalizeItem(value: unknown): HomeSuggestion | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const o = value as Record<string, unknown>;
  const category = normalizeCategory(o.category);
  if (!category) {
    return null;
  }
  if (typeof o.label !== "string" || typeof o.prompt !== "string") {
    return null;
  }
  const label = o.label.trim();
  const prompt = o.prompt.trim();
  if (!label || !prompt) {
    return null;
  }
  return { category, label, prompt };
}

function tryParseSlice(slice: string): HomeSuggestion[] {
  const parsed: unknown = JSON.parse(slice);
  const arr = coerceToSuggestionArray(parsed);
  return arr
    .map(normalizeItem)
    .filter((x): x is HomeSuggestion => x !== null)
    .slice(0, 20);
}

function coerceToAppRecommendationsArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const keys = [
      "appRecommendations",
      "apps",
      "recommendations",
      "items",
    ] as const;
    for (const k of keys) {
      const v = o[k];
      if (Array.isArray(v)) {
        return v;
      }
    }
    const vals = Object.values(o);
    if (vals.length === 1 && Array.isArray(vals[0])) {
      return vals[0];
    }
  }
  return [];
}

function normalizeBadgeIcon(value: unknown): AppBadgeIcon {
  if (typeof value === "string") {
    const v = value.toLowerCase().trim() as AppBadgeIcon;
    if (VALID_BADGE_ICONS.has(v)) return v;
  }
  return "info";
}

function normalizeBadge(value: unknown): AppRecommendationBadge | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.label !== "string") return null;
  const label = o.label.trim();
  if (!label) return null;
  return { icon: normalizeBadgeIcon(o.icon), label };
}

function normalizeAppRecommendation(value: unknown): AppRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.label !== "string" || typeof o.prompt !== "string") return null;
  const label = o.label.trim();
  const prompt = o.prompt.trim();
  if (!label || !prompt) return null;
  const description = typeof o.description === "string"
    ? o.description.trim()
    : "";
  const badgesInput = Array.isArray(o.badges) ? o.badges : [];
  const badges = badgesInput
    .map(normalizeBadge)
    .filter((b): b is AppRecommendationBadge => b !== null)
    .slice(0, 4);
  return { label, description, prompt, badges };
}

function tryParseAppRecommendations(slice: string): AppRecommendation[] {
  const parsed: unknown = JSON.parse(slice);
  const arr = coerceToAppRecommendationsArray(parsed);
  return arr
    .map(normalizeAppRecommendation)
    .filter((x): x is AppRecommendation => x !== null)
    .slice(0, 3);
}

export const parseAppRecommendationsFromModelText = (
  text: string | undefined,
): AppRecommendation[] => {
  const raw = text?.trim();
  if (!raw) return [];

  const attempts: string[] = [stripMarkdownFences(raw), raw.trim()];
  const seen = new Set<string>();
  const uniqueAttempts = attempts.filter((a) => {
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  });

  for (const candidate of uniqueAttempts) {
    const sliceSet = new Set<string>();
    const block = extractJsonBlock(candidate);
    if (block) sliceSet.add(block);
    const slices = [...sliceSet];
    if (slices.length === 0 && candidate.length > 0) {
      try {
        return tryParseAppRecommendations(candidate);
      } catch {
        /* fall through */
      }
    }
    for (const slice of slices) {
      try {
        const out = tryParseAppRecommendations(slice);
        if (out.length > 0) return out;
      } catch {
        /* next slice */
      }
    }
  }

  return [];
};

export const parseHomeSuggestionsFromModelText = (
  text: string | undefined,
): HomeSuggestion[] => {
  const raw = text?.trim();
  if (!raw) {
    return [];
  }

  const attempts: string[] = [stripMarkdownFences(raw), raw.trim()];
  const seen = new Set<string>();
  const uniqueAttempts = attempts.filter((a) => {
    if (seen.has(a)) {
      return false;
    }
    seen.add(a);
    return true;
  });

  for (const candidate of uniqueAttempts) {
    const sliceSet = new Set<string>();
    const block = extractJsonBlock(candidate);
    if (block) {
      sliceSet.add(block);
    }
    const slices = [...sliceSet];
    if (slices.length === 0 && candidate.length > 0) {
      try {
        return tryParseSlice(candidate);
      } catch {
        /* fall through */
      }
    }

    for (const slice of slices) {
      try {
        const out = tryParseSlice(slice);
        if (out.length > 0) {
          return out;
        }
      } catch {
        /* next slice */
      }
    }
  }

  return [];
};
