/**
 * Minimal JSON Schema validator for workflow `agent()` structured
 * output. Supports the subset orchestration scripts actually use —
 * type, properties/required, items, enum, additionalProperties, and
 * basic bounds — and reports precise paths so a failed validation can
 * be fed back to a repair agent verbatim. Deliberately not a full
 * draft-2020 implementation; unknown keywords are ignored.
 */

export type SchemaValidationResult = {
  valid: boolean;
  errors: string[];
};

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "object":
      return typeOf(value) === "object";
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
};

const validateAt = (
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void => {
  if (errors.length >= 20) return;

  const expectedType = schema.type;
  if (typeof expectedType === "string" && !matchesType(value, expectedType)) {
    errors.push(`${path}: expected ${expectedType}, got ${typeOf(value)}`);
    return;
  }
  if (Array.isArray(expectedType)) {
    if (!expectedType.some((t) => typeof t === "string" && matchesType(value, t))) {
      errors.push(
        `${path}: expected one of [${expectedType.join(", ")}], got ${typeOf(value)}`,
      );
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    const matches = schema.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    );
    if (!matches) {
      errors.push(`${path}: not one of the allowed enum values`);
      return;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((entry, index) =>
        validateAt(entry, items as Record<string, unknown>, `${path}[${index}]`, errors),
      );
    }
  }

  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : undefined;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in record)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in record)) continue;
        if (propertySchema && typeof propertySchema === "object") {
          validateAt(
            record[key],
            propertySchema as Record<string, unknown>,
            `${path}.${key}`,
            errors,
          );
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in properties)) {
            errors.push(`${path}: unexpected property "${key}"`);
          }
        }
      }
    }
  }
};

export const validateAgainstSchema = (
  value: unknown,
  schema: Record<string, unknown>,
): SchemaValidationResult => {
  const errors: string[] = [];
  validateAt(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
};

/**
 * Extract a JSON value from an agent's final text: prefers the LAST
 * fenced ```json block, then the last fenced block of any kind, then
 * the widest braces/brackets span. Returns undefined when nothing
 * parses.
 */
export const extractJsonValue = (raw: string): unknown => {
  const text = raw.trim();
  if (!text) return undefined;
  const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const candidate = fences[i]?.[1]?.trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
    }
  }
  return undefined;
};
