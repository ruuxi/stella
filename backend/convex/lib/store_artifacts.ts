/**
 * Phase 2 placeholder. The blueprint-shaped publish flow is being
 * rebuilt — the Store agent authors a markdown blueprint that gets
 * shipped as the release payload. This module keeps the small set of
 * helpers existing call sites still need (category normalization,
 * comment-strip helper for surfaces that snapshot raw code) until
 * the new publish action lands.
 */

export type StorePackageCategory =
  | "apps-games"
  | "productivity"
  | "customization"
  | "skills-agents"
  | "integrations"
  | "other";

export const STORE_PACKAGE_CATEGORIES = [
  "apps-games",
  "productivity",
  "customization",
  "skills-agents",
  "integrations",
  "other",
] as const;

export const isStorePackageCategory = (
  value: string,
): value is StorePackageCategory =>
  (STORE_PACKAGE_CATEGORIES as readonly string[]).includes(value);

export const normalizeStoreCategory = (
  value: string | undefined,
): StorePackageCategory => {
  const normalized = value?.trim().toLowerCase();
  if (normalized && isStorePackageCategory(normalized)) return normalized;
  if (normalized === "agents") return "skills-agents";
  if (normalized === "stella") return "other";
  return "other";
};
