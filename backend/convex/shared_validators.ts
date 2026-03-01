import { type Validator, type Value, v } from "convex/values";
import { ConvexError } from "convex/values";

/**
 * Runtime bounded-string check. Convex has no v.custom(), so we validate
 * inside handlers and throw a structured ConvexError on violation.
 */
export const requireBoundedString = (
  value: string,
  fieldName: string,
  maxLength: number,
): void => {
  if (value.length > maxLength) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} exceeds maximum allowed length of ${maxLength} characters`,
    });
  }
};

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

export const channelAttachmentValidator = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  mimeType: v.optional(v.string()),
  url: v.optional(v.string()),
  size: v.optional(v.number()),
  kind: v.optional(v.string()),
  providerMeta: optionalJsonValueValidator,
});

export const channelReactionValidator = v.object({
  emoji: v.string(),
  action: v.union(v.literal("add"), v.literal("remove")),
  targetMessageId: v.optional(v.string()),
});

export const channelEnvelopeValidator = v.object({
  provider: v.string(),
  kind: v.union(
    v.literal("message"),
    v.literal("reaction"),
    v.literal("edit"),
    v.literal("delete"),
    v.literal("system"),
  ),
  chatType: v.optional(v.string()),
  externalUserId: v.optional(v.string()),
  externalChatId: v.optional(v.string()),
  externalMessageId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  text: v.optional(v.string()),
  attachments: v.optional(v.array(channelAttachmentValidator)),
  reactions: v.optional(v.array(channelReactionValidator)),
  sourceTimestamp: v.optional(v.number()),
  providerPayload: optionalJsonValueValidator,
});
export const optionalChannelEnvelopeValidator = v.optional(channelEnvelopeValidator);

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
