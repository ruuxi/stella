import {
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { requireUserId } from "../auth";
import { hashSha256Hex } from "../lib/crypto_utils";
import {
  CONNECTED_MODE_REQUIRED_ERROR,
  evaluateLinkingDmPolicy,
  isOwnerInConnectedMode,
} from "./routing_flow";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generateSecureLinkCode = (length = 6): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length]).join("");
};

const linkCodeSalt = () => generateSecureLinkCode(16);

const hashLinkCode = async (code: string, salt: string) =>
  hashSha256Hex(`${salt}:${code}`);

const parseLinkCodeValue = (
  value: string,
): {
  codeHash?: string;
  codeSalt?: string;
  expiresAt?: number;
} | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as {
      codeHash?: string;
      codeSalt?: string;
      expiresAt?: number;
    };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const peekLinkCodeOwner = internalQuery({
  args: {
    provider: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    const now = Date.now();

    for (const pref of prefs) {
      const parsed = parseLinkCodeValue(pref.value);
      if (!parsed) {
        continue;
      }

      if (
        !parsed.codeHash ||
        !parsed.codeSalt ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= now
      ) {
        continue;
      }

      const candidateHash = await hashLinkCode(args.code, parsed.codeSalt);
      if (candidateHash === parsed.codeHash) {
        return pref.ownerId;
      }
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

export const storeLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
    const now = Date.now();
    const salt = linkCodeSalt();
    const codeHash = await hashLinkCode(args.code, salt);
    const value = JSON.stringify({
      codeHash,
      codeSalt: salt,
      expiresAt: now + 5 * 60 * 1000,
    });

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", key))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: now });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId: args.ownerId,
        key,
        value,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const consumeLinkCode = internalMutation({
  args: {
    provider: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    const now = Date.now();

    for (const pref of prefs) {
      const parsed = parseLinkCodeValue(pref.value);
      if (!parsed) {
        continue;
      }

      if (
        !parsed.codeHash ||
        !parsed.codeSalt ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= now
      ) {
        continue;
      }

      const candidateHash = await hashLinkCode(args.code, parsed.codeSalt);
      if (candidateHash === parsed.codeHash) {
        await ctx.db.delete(pref._id);
        return pref.ownerId;
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public Mutations (for frontend)
// ---------------------------------------------------------------------------

export const generateLinkCode = mutation({
  args: { provider: v.string() },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      throw new Error(CONNECTED_MODE_REQUIRED_ERROR);
    }

    const code = generateSecureLinkCode(6);

    await ctx.runMutation(internal.channels.link_codes.storeLinkCode, {
      ownerId,
      provider: args.provider,
      code,
    });

    return { code };
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
    { provider: args.provider, code: args.code },
  );
  if (!ownerId) return "invalid_code";

  if (!(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId }))) return "linking_disabled";

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
