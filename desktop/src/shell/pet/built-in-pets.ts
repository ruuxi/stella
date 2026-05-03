/**
 * Public pet catalog item. Metadata is loaded from Convex; spritesheets remain
 * hosted in R2 and are referenced by `spritesheetUrl`.
 *
 * Each entry is the minimum the picker page and overlay sprite renderer
 * need: stable id, display copy, sprite URL, and a kind/tags pair so we
 * can offer simple filtering without forking the share's UX.
 */
export type BuiltInPet = {
  id: string;
  displayName: string;
  description: string;
  kind: string;
  tags: string[];
  ownerName: string | null;
  spritesheetUrl: string;
  sourceUrl: string;
  /** Convenience alias used by older overlay code paths. */
  creator: string;
  /** Public selection counter pulled from Convex. */
  downloads: number;
};

export const normalizePet = (pet: Partial<BuiltInPet>): BuiltInPet | null => {
  if (!pet || typeof pet.id !== "string" || pet.id.length === 0) return null;
  const ownerName =
    typeof pet.ownerName === "string" && pet.ownerName.length > 0
      ? pet.ownerName
      : null;
  return {
    id: pet.id,
    displayName: pet.displayName?.trim() || pet.id,
    description: pet.description?.trim() ?? "",
    kind: pet.kind ?? "object",
    tags: Array.isArray(pet.tags) ? pet.tags.filter((t): t is string => typeof t === "string") : [],
    ownerName,
    spritesheetUrl: pet.spritesheetUrl ?? "",
    sourceUrl: pet.sourceUrl ?? "",
    creator: ownerName ?? "Codex Pet Share",
    downloads:
      typeof pet.downloads === "number" && Number.isFinite(pet.downloads)
        ? Math.max(0, Math.floor(pet.downloads))
        : 0,
  };
};

/** Stable id used when the user hasn't picked a pet yet. Must match a
 *  `BUNDLED_PETS` entry so the default is always renderable, even
 *  offline or before Convex has hydrated. */
export const DEFAULT_PET_ID = "stella";
