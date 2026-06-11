import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:engine-model-favorites";

type FavoriteScope = string;

const readAll = (): Record<FavoriteScope, string[]> => {
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<FavoriteScope, string[]> = {};
    for (const [scope, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      next[scope] = value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      );
    }
    return next;
  } catch {
    return {};
  }
};

const writeAll = (value: Record<FavoriteScope, string[]>): void => {
  uiState.setItem(STORAGE_KEY, JSON.stringify(value));
};

export const readEngineModelFavorites = (scope: FavoriteScope): string[] => {
  return readAll()[scope] ?? [];
};

export const toggleEngineModelFavorite = (
  scope: FavoriteScope,
  modelId: string,
): string[] => {
  const trimmed = modelId.trim();
  if (!trimmed) return readEngineModelFavorites(scope);
  const all = readAll();
  const current = all[scope] ?? [];
  const next = current.includes(trimmed)
    ? current.filter((entry) => entry !== trimmed)
    : [trimmed, ...current];
  writeAll({ ...all, [scope]: next });
  return next;
};

export const sortByFavorites = <T extends { id: string }>(
  items: readonly T[],
  favorites: readonly string[],
): T[] => {
  if (favorites.length === 0) return [...items];
  const rank = new Map(favorites.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const aRank = rank.get(a.id);
    const bRank = rank.get(b.id);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return 0;
  });
};
