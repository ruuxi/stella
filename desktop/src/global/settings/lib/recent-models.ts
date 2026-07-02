import { uiState } from "@/platform/ui-state";

/**
 * Recently used assistant models, persisted across sessions. The sidebar
 * model popover surfaces the freshest few so switching back and forth
 * between a user's usual models is one click.
 *
 * Stored newest-first as override ids (`stella/<mode>`,
 * `openrouter/<model>`, `claude-code/<model>`, …). The empty-string
 * "default" pick is never recorded — the Default row is always present.
 */
const STORAGE_KEY = "stella:recent-models";
const MAX_STORED = 8;

export const readRecentModels = (): string[] => {
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  } catch {
    return [];
  }
};

export const recordRecentModel = (modelId: string): string[] => {
  const trimmed = modelId.trim();
  if (!trimmed) return readRecentModels();
  const next = [
    trimmed,
    ...readRecentModels().filter((entry) => entry !== trimmed),
  ].slice(0, MAX_STORED);
  try {
    uiState.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; ignore storage failures.
  }
  return next;
};
