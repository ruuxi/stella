export const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const stringify = (input: unknown): string => {
    if (input === null || typeof input !== "object") {
      return JSON.stringify(input);
    }
    if (seen.has(input as object)) {
      return JSON.stringify("[Circular]");
    }
    seen.add(input as object);
    if (Array.isArray(input)) {
      return `[${input.map((item) => stringify(item)).join(",")}]`;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const body = keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`);
    return `{${body.join(",")}}`;
  };
  return stringify(value);
};

export const extractJsonBlock = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const startCandidates = [firstObject, firstArray].filter((idx) => idx >= 0);
  if (startCandidates.length === 0) {
    return null;
  }
  const start = Math.min(...startCandidates);
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayEnd = trimmed.lastIndexOf("]");
  const endCandidates = [objectEnd, arrayEnd].filter((idx) => idx >= start);
  if (endCandidates.length === 0) {
    return null;
  }
  const end = Math.max(...endCandidates);
  const candidate = trimmed.slice(start, end + 1).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
};
