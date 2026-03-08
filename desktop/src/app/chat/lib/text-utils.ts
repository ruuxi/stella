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
