import { query, action } from "../_generated/server";
import { v } from "convex/values";
import { requireUserId } from "../auth";

/**
 * Check if STT (speech-to-text) is available for the current deployment.
 * Returns true when WISPR_API_KEY environment variable is configured.
 */
export const checkSttAvailable = query({
  args: {},
  returns: v.object({ available: v.boolean() }),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const key = process.env.WISPR_API_KEY ?? "";
    return { available: key.length > 0 };
  },
});

/**
 * Generate a short-lived Wispr Flow JWT token for the authenticated user.
 * Uses the platform WISPR_API_KEY to call Wispr's /generate_access_token endpoint,
 * scoping the token to the user's ID as client_id for per-user isolation.
 */
export const generateSttToken = action({
  args: {
    durationSecs: v.optional(v.number()),
  },
  returns: v.object({
    token: v.optional(v.string()),
    error: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const apiKey = process.env.WISPR_API_KEY ?? "";
    if (!apiKey) {
      return { error: "STT not configured" };
    }

    const duration = args.durationSecs ?? 300;
    try {
      const response = await fetch(
        "https://platform-api.wisprflow.ai/generate_access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            client_id: userId,
            duration_secs: duration,
            metadata: { source: "stella" },
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { error: `Token generation failed: ${response.status} ${text}` };
      }

      const data = (await response.json()) as {
        access_token?: string;
        token?: string;
        expires_in?: number;
      };
      return {
        token: data.access_token ?? data.token,
        expiresAt: Date.now() + duration * 1000,
      };
    } catch (err) {
      return { error: `Token request failed: ${(err as Error).message}` };
    }
  },
});
