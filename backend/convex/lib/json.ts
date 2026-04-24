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

/**
 * Safely parse a JSON string that is expected to be a plain object.
 * Returns `null` for arrays, primitives, or invalid JSON.
 */
export function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const extractJsonBlock = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const candidate = extractJsonValueBlock(trimmed);
  if (!candidate) return null;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
};

export const extractJsonValueBlock = (text: string): string | null => {
  const trimmed = text.trim();
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  if (objectStart < 0 && arrayStart < 0) return null;
  const start = objectStart < 0
    ? arrayStart
    : arrayStart < 0
      ? objectStart
      : Math.min(objectStart, arrayStart);

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1).trim();
      }
    }
  }
  return null;
};
