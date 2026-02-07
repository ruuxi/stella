import { v } from "convex/values";

// Shared loose validators for intentionally dynamic JSON-shaped data.
export const jsonValueValidator = v.any();
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
