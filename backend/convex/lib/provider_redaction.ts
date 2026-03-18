export const scrubProviderTerms = (value: string) =>
  value
    .replace(/openai|anthropic|claude|gpt-?\d*|gemini|llama|mistral/gi, "model")
    .replace(/provider|model\s+id|model\s+name/gi, "model");

export const scrubValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return scrubProviderTerms(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      scrubValue(v),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
};
