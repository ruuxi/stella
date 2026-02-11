import { type Validator, type Value, v } from "convex/values";

type JsonValidator = Validator<Value, "required", string>;

// Build a JSON validator without using v.any().
// Depth is bounded to keep validator construction finite.
const jsonPrimitiveValidator = v.union(v.null(), v.boolean(), v.number(), v.string());
const buildJsonValueValidator = (depth: number): JsonValidator => {
  if (depth <= 0) return jsonPrimitiveValidator as JsonValidator;
  const nested = buildJsonValueValidator(depth - 1);
  return v.union(
    jsonPrimitiveValidator,
    v.array(nested),
    v.record(v.string(), nested),
  ) as JsonValidator;
};

export const jsonValueValidator = buildJsonValueValidator(8);
export const jsonObjectValidator = v.record(v.string(), jsonValueValidator);
export const jsonSchemaValidator = v.union(v.boolean(), jsonObjectValidator);
export const optionalJsonValueValidator = v.optional(jsonValueValidator);

// Shared validators for skill secret mounts.
export const secretMountSpecValidator = v.object({
  provider: v.string(),
  label: v.optional(v.string()),
  description: v.optional(v.string()),
  placeholder: v.optional(v.string()),
});
export const secretMountBindingValidator = v.union(v.string(), secretMountSpecValidator);
export const secretMountMapValidator = v.record(v.string(), secretMountBindingValidator);
export const secretMountsValidator = v.optional(
  v.union(
    secretMountMapValidator,
    v.object({
      env: v.optional(secretMountMapValidator),
      files: v.optional(secretMountMapValidator),
    }),
  ),
);
