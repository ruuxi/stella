import { query } from "../_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// WhatsApp Connector (Baileys bridge)
//
// The WhatsApp bridge runs as a persistent process in a Sprites.dev container.
// Setup and lifecycle are managed by bridge.ts. This module provides
// frontend-facing queries specific to the WhatsApp auth flow (QR code).
// ---------------------------------------------------------------------------

/**
 * Returns the QR code data for WhatsApp pairing.
 * Frontend renders this as a scannable QR code.
 */
export const getQrCode = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const session = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", identity.subject).eq("provider", "whatsapp"),
      )
      .unique();

    if (!session || session.status !== "awaiting_auth") return null;
    const qrCode = (session.authState as Record<string, unknown>)?.qrCode;
    return typeof qrCode === "string" ? qrCode : null;
  },
});
