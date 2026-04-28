import { defineTable } from "convex/server";
import { v } from "convex/values";

// Anonymous user feedback. The submitting user's identity is intentionally
// NOT stored — the desktop UI promises anonymity, so the only metadata we
// keep is what the renderer chose to volunteer (app version / platform) so
// we can group reports by build without re-identifying the sender.
export const feedbackSchema = {
  user_feedback: defineTable({
    message: v.string(),
    createdAt: v.number(),
    appVersion: v.optional(v.string()),
    platform: v.optional(v.string()),
  }).index("by_createdAt", ["createdAt"]),
};
