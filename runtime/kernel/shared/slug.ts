/**
 * Deterministic slugs for runtime thread keys, thread-group keys, and
 * self-mod feature trailers.
 *
 * Slugs are derived once at write time from orchestrator-authored text
 * (spawn descriptions, group labels) and never regenerated, so the ids
 * the model quotes back (`send_input`, `pause_agent`) stay readable and
 * stable. The output alphabet is a strict subset of
 * `STELLA_TRAILER_VALUE_REGEX`, so a slug is always safe to stamp into
 * a git trailer without further sanitizing.
 */

const DEFAULT_MAX_SLUG_LENGTH = 48;

export const slugify = (
  value: string,
  maxLength = DEFAULT_MAX_SLUG_LENGTH,
): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  // Cut on a word boundary when one exists reasonably close to the limit.
  return (lastDash > 8 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
};
