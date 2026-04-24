import {
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError } from "convex/values";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { hashSha256Hex } from "../lib/crypto_utils";
import {
  enforceMutationRateLimit,
  RATE_SENSITIVE,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import {
  SIGN_IN_REQUIRED_ERROR,
  evaluateLinkingDmPolicy,
} from "./routing_flow";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generateSecureLinkCode = (length = 6): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length]).join("");
};

const normalizeLinkCode = (code: string): string => code.trim().toUpperCase();

/**
 * Deterministic, namespaced hash used as the lookup key on `link_codes`.
 *
 * The `link_code:v1` prefix scopes the hash to this purpose so the same code
 * value cannot collide with other hashes stored elsewhere, and lets us
 * version the scheme if we ever swap to an HMAC with a server pepper. We use
 * a plain SHA-256 (no per-row salt, no pepper) because:
 *   - codes carry a 5-minute TTL and are issued exactly once per owner
 *   - the public API surface is rate limited
 *   - the realistic threat (DB-read attacker recovering a code) requires
 *     cross-channel access on the *foreign* provider within the TTL window
 * If that threat model changes, swap this for HMAC-SHA256 keyed off a new
 * `STELLA_LINK_CODE_HASH_PEPPER` env var and bump the version prefix.
 */
const hashLinkCodeForLookup = async (
  provider: string,
  code: string,
): Promise<string> => hashSha256Hex(`link_code:v1:${provider}:${normalizeLinkCode(code)}`);

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

/**
 * Resolve a link code to its issuing owner without consuming it. Callers must
 * pass `nowMs` (queries cannot read `Date.now()` deterministically) so the
 * expiry check stays cache-stable.
 */
export const peekLinkCodeOwner = internalQuery({
  args: {
    provider: v.string(),
    code: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const codeHash = await hashLinkCodeForLookup(args.provider, args.code);
    const row = await ctx.db
      .query("link_codes")
      .withIndex("by_provider_and_codeHash", (q) =>
        q.eq("provider", args.provider).eq("codeHash", codeHash),
      )
      .unique();
    if (!row || row.expiresAt <= args.nowMs) {
      return null;
    }
    return row.ownerId;
  },
});

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

/**
 * Insert (or replace) the active link code for `(ownerId, provider)`. There
 * is at most one active code per owner+provider; regenerating the code
 * overwrites the previous row so it cannot be claimed twice.
 */
const writeLinkCodeRow = async (
  ctx: Pick<MutationCtx, "db">,
  args: { ownerId: string; provider: string; code: string; nowMs: number },
) => {
  const codeHash = await hashLinkCodeForLookup(args.provider, args.code);
  const existing = await ctx.db
    .query("link_codes")
    .withIndex("by_ownerId_and_provider", (q) =>
      q.eq("ownerId", args.ownerId).eq("provider", args.provider),
    )
    .unique();

  const patch = {
    codeHash,
    expiresAt: args.nowMs + LINK_CODE_TTL_MS,
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
  } else {
    await ctx.db.insert("link_codes", {
      ownerId: args.ownerId,
      provider: args.provider,
      codeHash,
      expiresAt: args.nowMs + LINK_CODE_TTL_MS,
      createdAt: args.nowMs,
    });
  }
};

export const storeLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    code: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeLinkCodeRow(ctx, { ...args, nowMs: Date.now() });
    return null;
  },
});

export const consumeLinkCode = internalMutation({
  args: {
    provider: v.string(),
    code: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const codeHash = await hashLinkCodeForLookup(args.provider, args.code);
    const row = await ctx.db
      .query("link_codes")
      .withIndex("by_provider_and_codeHash", (q) =>
        q.eq("provider", args.provider).eq("codeHash", codeHash),
      )
      .unique();
    if (!row) return null;
    if (row.expiresAt <= Date.now()) {
      await ctx.db.delete(row._id);
      return null;
    }
    await ctx.db.delete(row._id);
    return row.ownerId;
  },
});

export const generateAndStoreLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const code = generateSecureLinkCode(6);
    await writeLinkCodeRow(ctx, {
      ownerId: args.ownerId,
      provider: args.provider,
      code,
      nowMs: Date.now(),
    });
    return { code };
  },
});

/**
 * Periodic cleanup for expired link code rows. Bounded per-call so the
 * sweeper cron stays inside transaction limits even if a backlog accumulates;
 * self-reschedules through the cron tick rather than chaining `runAfter`.
 */
export const purgeExpiredLinkCodes = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(Math.floor(args.batchSize ?? 200), 1), 1000);
    const now = Date.now();
    const expired = await ctx.db
      .query("link_codes")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    return { deleted: expired.length, hasMore: expired.length === batchSize };
  },
});

// ---------------------------------------------------------------------------
// Public Mutations (for frontend)
// ---------------------------------------------------------------------------

export const generateLinkCode = mutation({
  args: { provider: v.string() },
  returns: v.object({ code: v.string()  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    }
    if ((identity as Record<string, unknown>).isAnonymous === true) {
      throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    }
    const ownerId = identity.tokenIdentifier;

    await enforceMutationRateLimit(
      ctx,
      "channel_generate_link_code",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many link-code requests. Please wait a minute before generating another.",
    );

    const code = generateSecureLinkCode(6);

    await ctx.runMutation(internal.channels.link_codes.storeLinkCode, {
      ownerId,
      provider: args.provider,
      code,
    });

    return { code };
  },
});

export const verifyLinqLinkCode = mutation({
  args: {
    code: v.string(),
    phoneNumber: v.string(),
  },
  returns: v.object({
    result: v.union(
      v.literal("linked"),
      v.literal("invalid_code"),
      v.literal("owner_mismatch"),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    if ((identity as Record<string, unknown>).isAnonymous === true) {
      throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    }
    const ownerId = identity.tokenIdentifier;

    // Tight per-owner cap: this is the brute-force surface for link codes,
    // so we want even a hijacked session to burn through its window long
    // before guessing a 6-char code (~2^31 search space).
    await enforceMutationRateLimit(
      ctx,
      "channel_verify_linq_link_code",
      ownerId,
      RATE_SENSITIVE,
      "Too many code attempts. Please wait a minute before trying again.",
    );

    const code = normalizeLinkCode(args.code);

    const codeOwner = await ctx.runQuery(
      internal.channels.link_codes.peekLinkCodeOwner,
      { provider: "linq", code, nowMs: Date.now() },
    );
    if (!codeOwner) return { result: "invalid_code" as const };
    if (codeOwner !== ownerId) return { result: "owner_mismatch" as const };

    const consumedOwner = await ctx.runMutation(
      internal.channels.link_codes.consumeLinkCode,
      { provider: "linq", code },
    );
    if (!consumedOwner || consumedOwner !== ownerId) {
      return { result: "invalid_code" as const };
    }

    await ctx.runMutation(internal.channels.utils.createConnection, {
      ownerId,
      provider: "linq",
      externalUserId: args.phoneNumber,
    });

    await ctx.scheduler.runAfter(0, internal.channels.linq.sendWelcomeMessage, {
      phoneNumber: args.phoneNumber,
    });

    return { result: "linked" as const };
  },
});

// ---------------------------------------------------------------------------
// Shared Helper Functions (called from provider action handlers)
// ---------------------------------------------------------------------------

/**
 * Common link code validation: consume code -> check existing ->
 * create connection -> return status.
 */
export async function processLinkCode(args: {
  ctx: ActionCtx;
  provider: string;
  externalUserId: string;
  code: string;
  displayName?: string;
}): Promise<"linked" | "already_linked" | "invalid_code" | "linking_disabled" | "not_allowed"> {
  const existing = await args.ctx.runQuery(
    internal.channels.utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
  if (existing) return "already_linked";

  const ownerId = await args.ctx.runQuery(
    internal.channels.link_codes.peekLinkCodeOwner,
    { provider: args.provider, code: args.code, nowMs: Date.now() },
  );
  if (!ownerId) return "invalid_code";

  const policy = await args.ctx.runQuery(internal.channels.utils.getDmPolicyConfig, {
    ownerId,
    provider: args.provider,
  });
  const linkingPolicyOutcome = evaluateLinkingDmPolicy({
    policy,
    externalUserId: args.externalUserId,
  });
  if (linkingPolicyOutcome) return linkingPolicyOutcome;

  const consumedOwnerId = await args.ctx.runMutation(
    internal.channels.link_codes.consumeLinkCode,
    { provider: args.provider, code: args.code },
  );
  if (!consumedOwnerId || consumedOwnerId !== ownerId) return "invalid_code";

  await args.ctx.runMutation(internal.channels.utils.createConnection, {
    ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
  });
  return "linked";
}

export type LinkCodeResult = Awaited<ReturnType<typeof processLinkCode>>;

export const formatLinkCodeResultMessage = (
  result: LinkCodeResult,
  args: {
    providerName: string;
    accountName?: string;
    linkedMessage: string;
  },
): string => {
  const accountName = args.accountName ?? `${args.providerName} account`;
  switch (result) {
    case "invalid_code":
      return "Invalid or expired code. Please generate a new one in Stella Settings.";
    case "already_linked":
      return `Your ${accountName} is already linked to Stella!`;
    case "linking_disabled":
      return `${args.providerName} linking is disabled while Private Local mode is on. Enable Connected mode in Stella Settings.`;
    case "not_allowed":
      return `This ${accountName} is not allowed to link.`;
    case "linked":
      return args.linkedMessage;
  }
};
