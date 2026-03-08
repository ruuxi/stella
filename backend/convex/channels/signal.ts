import { query } from "../_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Signal Connector (signal-cli bridge)
//
// The Signal bridge runs as a local persistent process started from the
// desktop bridge bundle. Setup and lifecycle are managed by bridge.ts.
// This module provides
// frontend-facing queries specific to the Signal auth flow (device link URI).
// ---------------------------------------------------------------------------

/**
 * Returns the device link URI for Signal pairing.
 * Frontend renders this tsdevice:// URI as a scannable QR code.
 */
export const getLinkUri = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const session = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", identity.subject).eq("provider", "signal"),
      )
      .unique();

    if (!session || session.status !== "awaiting_auth") return null;
    const linkUri = (session.authState as Record<string, unknown>)?.linkUri;
    return typeof linkUri === "string" ? linkUri : null;
  },
});
