import { ConvexError } from "convex/values";
import { getModeConfig } from "../agent/model";
import {
  assistantText,
  completeManagedChat,
} from "../runtime_ai/managed";

/**
 * Cheap one-token moderation classifier shared by social chat (every
 * inbound message) and Store publish (display name + description on
 * the first release of a package). Returns YES/NO; callers decide
 * whether to censor in place (social) or block the action (publish).
 *
 * Kept in one place so we add a stem / tighten a rule once and both
 * surfaces benefit. Reusable across any short user-authored text where
 * we want a "would this be censored in a public-ish surface" signal.
 */
export const TEXT_MODERATION_SYSTEM_PROMPT = [
  "You are a social chat moderation classifier.",
  "Return exactly one token: YES or NO.",
  "",
  "YES means the text contains content that should be censored in a public surface: slurs, dehumanizing hate, harassment, explicit sexual content, sexual assault language, child sexual abuse references, or common bypass variants.",
  "NO means the text is safe to publish as written.",
  "Catch evasion such as repeated letters, leetspeak, separators, zero-width characters, and Unicode lookalikes.",
].join("\n");

export type TextModerationDecision = "clean" | "censored" | "failed";

export function parseModerationResponse(raw: string): TextModerationDecision {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "YES") return "censored";
  if (normalized === "NO") return "clean";
  const firstToken = normalized.split(/\s+/)[0];
  if (firstToken === "YES") return "censored";
  if (firstToken === "NO") return "clean";
  return "failed";
}

/**
 * Run the moderation classifier against a single chunk of user text.
 * On model error or unparseable output, returns `"failed"` so callers
 * can choose between fail-open (chat: allow + mark) and fail-closed
 * (publish: refuse).
 */
export async function classifyTextForModeration(
  text: string,
): Promise<TextModerationDecision> {
  if (!text.trim()) return "clean";
  try {
    const result = await completeManagedChat({
      config: getModeConfig("light"),
      fallbackConfig: {
        ...getModeConfig("standard"),
        temperature: 0.7,
        maxOutputTokens: 512,
      },
      context: {
        systemPrompt: TEXT_MODERATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: text,
            timestamp: Date.now(),
          },
        ],
      },
    });
    return parseModerationResponse(assistantText(result));
  } catch (error) {
    console.warn("[text-moderation] classifier failed:", error);
    return "failed";
  }
}

/**
 * Block a Store publish when the user-provided display name or
 * description trips the moderation classifier. Composes one or more
 * fields into a single check so we don't pay for two model calls when
 * one is enough; if a single field decides "censored", reject loudly.
 *
 * `failed` is treated as fail-closed for publish — the action runs
 * once on a deliberate user submit, latency is fine, and we'd rather
 * surface a "try again" toast than silently let bad text through.
 */
export async function moderateStoreListingTextOrThrow(args: {
  displayName: string;
  description?: string;
}): Promise<void> {
  const fields: Array<{ label: string; value: string }> = [
    { label: "Name", value: args.displayName.trim() },
  ];
  const trimmedDescription = args.description?.trim();
  if (trimmedDescription) {
    fields.push({ label: "Description", value: trimmedDescription });
  }
  const composite = fields
    .map(({ label, value }) => `${label}: ${value}`)
    .join("\n");
  const decision = await classifyTextForModeration(composite);
  if (decision === "censored") {
    throw new ConvexError({
      code: "STORE_LISTING_REJECTED",
      message:
        "Listing was blocked by automated moderation. Please rephrase the name or description and try again.",
    });
  }
  if (decision === "failed") {
    throw new ConvexError({
      code: "STORE_LISTING_REVIEW_FAILED",
      message:
        "Couldn't run automated moderation on your listing right now. Please try again in a moment.",
    });
  }
}
