const DEFAULT_TRUNCATION_SUFFIX = "...(truncated)";

export const truncateWithSuffix = (
  value: string,
  maxChars: number,
  suffix = DEFAULT_TRUNCATION_SUFFIX,
): string => (value.length <= maxChars ? value : `${value.slice(0, maxChars)}${suffix}`);

export const stringifyBounded = (value: unknown, maxChars: number): string => {
  if (typeof value === "string") {
    return truncateWithSuffix(value.trim(), maxChars);
  }
  try {
    return truncateWithSuffix(JSON.stringify(value), maxChars);
  } catch {
    return truncateWithSuffix(String(value), maxChars);
  }
};

/** Collapse whitespace, trim, and cap length. Accepts `unknown` for raw LLM output. */
export const normalizeText = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
};

/** Deduplicate and cap a list of source strings (case-insensitive). */
export const cleanSources = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const s = normalizeText(item, 120);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 8);
};

/** Lowercase slug: a-z, 0-9, underscores only. */
export const slugify = (value: string, maxLen = 48): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
