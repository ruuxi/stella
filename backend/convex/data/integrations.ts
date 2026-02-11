import { mutation, query, internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { requireUserId } from "../auth";
import { jsonObjectValidator } from "../shared_validators";

export const listPublicIntegrations = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("integrations_public"),
      id: v.string(),
      provider: v.string(),
      enabled: v.boolean(),
      usagePolicy: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return await ctx.db.query("integrations_public").take(200);
  },
});

export const upsertPublicIntegration = internalMutation({
  args: {
    id: v.string(),
    provider: v.string(),
    enabled: v.boolean(),
    usagePolicy: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("integrations_public")
      .withIndex("by_integration_id", (q) => q.eq("id", args.id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        provider: args.provider,
        enabled: args.enabled,
        usagePolicy: args.usagePolicy,
        updatedAt: Date.now(),
      });
      return null;
    }

    await ctx.db.insert("integrations_public", {
      id: args.id,
      provider: args.provider,
      enabled: args.enabled,
      usagePolicy: args.usagePolicy,
      updatedAt: Date.now(),
    });
    return null;
  },
});

const SLACK_OAUTH_STATE_KEY = "slack_oauth_state";
const SLACK_OAUTH_SCOPE = "chat:write,im:history,im:read,im:write";
const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const generateSecureState = (bytesLength = 24) => {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random generator unavailable for Slack OAuth state");
  }
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const parseSlackState = (
  value: string,
): {
  state?: string;
  expiresAt?: number;
  usedAt?: number;
  createdAt?: number;
} | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as {
      state?: string;
      expiresAt?: number;
      usedAt?: number;
      createdAt?: number;
    };
  } catch {
    return null;
  }
};

export const createSlackInstallUrl = mutation({
  args: {},
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const clientId = process.env.SLACK_CLIENT_ID;
    const convexSiteUrl = process.env.CONVEX_SITE_URL;

    if (!clientId || !convexSiteUrl) {
      throw new Error("Missing Slack OAuth configuration");
    }

    const now = Date.now();
    const expiresAt = now + SLACK_OAUTH_STATE_TTL_MS;
    const state = generateSecureState();
    const value = JSON.stringify({
      state,
      expiresAt,
      createdAt: now,
    });

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) =>
        q.eq("ownerId", ownerId).eq("key", SLACK_OAUTH_STATE_KEY),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key: SLACK_OAUTH_STATE_KEY,
        value,
        updatedAt: now,
      });
    }

    const redirectUri = `${convexSiteUrl}/api/slack/oauth_callback`;
    const url =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SLACK_OAUTH_SCOPE)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return { url, expiresAt };
  },
});

export const consumeSlackOAuthState = internalMutation({
  args: {
    state: v.string(),
  },
  returns: v.union(v.null(), v.object({ ownerId: v.string() })),
  handler: async (ctx, args) => {
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_key", (q) => q.eq("key", SLACK_OAUTH_STATE_KEY))
      .collect();

    const now = Date.now();
    for (const pref of prefs) {
      const parsed = parseSlackState(pref.value);
      if (!parsed || parsed.state !== args.state) {
        continue;
      }

      if (typeof parsed.usedAt === "number") {
        return null;
      }

      if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
        return null;
      }

      await ctx.db.patch(pref._id, {
        value: JSON.stringify({
          state: parsed.state,
          expiresAt: parsed.expiresAt,
          createdAt: parsed.createdAt ?? now,
          usedAt: now,
        }),
        updatedAt: now,
      });
      return { ownerId: pref.ownerId };
    }

    return null;
  },
});

const getPublicIntegrationByIdHandler = async (ctx: { db: any }, args: { id: string }) => {
  const record = await ctx.db
    .query("integrations_public")
    .withIndex("by_integration_id", (q: any) => q.eq("id", args.id))
    .first();
  if (!record || !record.enabled) {
    return null;
  }
  return record;
};

const publicIntegrationReturnValidator = v.union(
  v.null(),
  v.object({
    _id: v.id("integrations_public"),
    id: v.string(),
    provider: v.string(),
    enabled: v.boolean(),
    usagePolicy: v.string(),
    updatedAt: v.number(),
  }),
);

export const getPublicIntegrationById = internalQuery({
  args: {
    id: v.string(),
  },
  returns: publicIntegrationReturnValidator,
  handler: async (ctx, args) => {
    return await getPublicIntegrationByIdHandler(ctx, args);
  },
});

export const getPublicIntegrationByIdInternal = internalQuery({
  args: {
    id: v.string(),
  },
  returns: publicIntegrationReturnValidator,
  handler: async (ctx, args) => {
    return await getPublicIntegrationByIdHandler(ctx, args);
  },
});

export const listUserIntegrations = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("user_integrations"),
      ownerId: v.string(),
      provider: v.string(),
      mode: v.string(),
      externalId: v.optional(v.string()),
      config: jsonObjectValidator,
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("user_integrations")
      .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

export const upsertUserIntegration = internalMutation({
  args: {
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: jsonObjectValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("user_integrations")
      .withIndex("by_owner_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode: args.mode,
        externalId: args.externalId,
        config: args.config,
        updatedAt: now,
      });
      return null;
    }

    await ctx.db.insert("user_integrations", {
      ownerId,
      provider: args.provider,
      mode: args.mode,
      externalId: args.externalId,
      config: args.config,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});
