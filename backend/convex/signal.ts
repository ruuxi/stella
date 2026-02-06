import { query } from "./_generated/server";

// ---------------------------------------------------------------------------
// Signal Connector (signal-cli bridge)
//
// The Signal bridge runs as a persistent process in a Sprites.dev container.
// Setup and lifecycle are managed by bridge.ts. This module provides
// frontend-facing queries specific to the Signal auth flow (device link URI).
// ---------------------------------------------------------------------------

/**
 * Returns the device link URI for Signal pairing.
 * Frontend renders this tsdevice:// URI as a scannable QR code.
 */
export const getLinkUri = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const session = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", identity.subject).eq("provider", "signal"),
      )
      .first();

    if (!session || session.status !== "awaiting_auth") return null;
    return (session.authState as Record<string, unknown>)?.linkUri ?? null;
  },
});
