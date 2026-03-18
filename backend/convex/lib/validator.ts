export type JsonSchema = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const validateAgainstSchema = (
  schema: JsonSchema | undefined,
  value: unknown,
): { ok: true } | { ok: false; reason: string } => {
  if (!schema) {
    return { ok: true };
  }
  const schemaType = typeof schema.type === "string" ? schema.type : undefined;

  if (schemaType === "object") {
    if (!isPlainObject(value)) {
      return { ok: false, reason: "Result must be a JSON object." };
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        return { ok: false, reason: `Missing required field: ${key}` };
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, rawPropSchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const prop = isPlainObject(rawPropSchema) ? rawPropSchema : {};
      const propType = typeof prop.type === "string" ? prop.type : undefined;
      const propValue = (value as Record<string, unknown>)[key];
      if (propType === "string" && typeof propValue !== "string") {
        return { ok: false, reason: `Field ${key} must be a string.` };
      }
      if (propType === "number" && typeof propValue !== "number") {
        return { ok: false, reason: `Field ${key} must be a number.` };
      }
      if (propType === "boolean" && typeof propValue !== "boolean") {
        return { ok: false, reason: `Field ${key} must be a boolean.` };
      }
      if (propType === "array" && !Array.isArray(propValue)) {
        return { ok: false, reason: `Field ${key} must be an array.` };
      }
      if (Array.isArray(prop.enum) && !prop.enum.includes(propValue)) {
        return { ok: false, reason: `Field ${key} must be one of the allowed enum values.` };
      }
      if (
        typeof prop.maxLength === "number" &&
        typeof propValue === "string" &&
        propValue.length > prop.maxLength
      ) {
        return { ok: false, reason: `Field ${key} exceeds maxLength.` };
      }
      if (
        typeof prop.maxItems === "number" &&
        Array.isArray(propValue) &&
        propValue.length > prop.maxItems
      ) {
        return { ok: false, reason: `Field ${key} exceeds maxItems.` };
      }
    }
    return { ok: true };
  }

  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      return { ok: false, reason: "Result must be a JSON array." };
    }
    const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
    if (typeof maxItems === "number" && value.length > maxItems) {
      return { ok: false, reason: `Array exceeds maxItems (${maxItems}).` };
    }
    return { ok: true };
  }

  if (schemaType === "string" && typeof value !== "string") {
    return { ok: false, reason: "Result must be a string." };
  }
  if (schemaType === "number" && typeof value !== "number") {
    return { ok: false, reason: "Result must be a number." };
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    return { ok: false, reason: "Result must be a boolean." };
  }

  return { ok: true };
};
