import type { HomeSuggestion } from "../prompts/synthesis";
import { extractJsonBlock } from "./json";

const VALID_CATEGORIES = new Set(["stella", "task", "explore", "schedule"]);

function stripMarkdownFences(text: string): string {
  const s = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) {
    return fenced[1].trim();
  }
  return s;
}

function findFirstJsonStart(s: string): number {
  const b = s.indexOf("{");
  const a = s.indexOf("[");
  if (a < 0 && b < 0) {
    return -1;
  }
  if (a < 0) {
    return b;
  }
  if (b < 0) {
    return a;
  }
  return Math.min(a, b);
}

/**
 * Extract a single balanced JSON value (object or array) from text.
 * Handles strings that contain `]` or `}` without relying on lastIndexOf.
 */
function extractBalancedJsonSlice(text: string): string | null {
  const trimmed = text.trim();
  const start = findFirstJsonStart(trimmed);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
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
    const balanced = extractBalancedJsonSlice(candidate);
    if (balanced) {
      sliceSet.add(balanced);
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
