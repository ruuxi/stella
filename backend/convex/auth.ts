import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { jwt, magicLink } from "better-auth/plugins";
import {
  internalAction,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { ConvexError, v } from "convex/values";

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

const extraTrustedOrigins = [
  "http://localhost:3000",
  "http://localhost:5174",
  "https://fromyou.ai",
];

const getDeepLinkOrigin = () => {
  const raw = process.env.STELLA_PROTOCOL;
  if (!raw) {
    return "Stella://auth";
  }
  const protocol = raw.replace("://", "").replace(":", "");
  return `${protocol}://auth`;
};

export const authComponent = createClient<DataModel>(components.betterAuth);
const resend = new Resend(components.resend, { testMode: false });

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = getRequiredEnv("SITE_URL");
  const convexSiteUrl = getRequiredEnv("CONVEX_SITE_URL");
  const trustedOrigins = Array.from(
    new Set(
      [siteUrl, getDeepLinkOrigin(), ...extraTrustedOrigins].filter(
        (origin): origin is string => Boolean(origin),
      ),
    ),
  );

  const options = {
    baseURL: convexSiteUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    // socialProviders: {
    //   google: {
    //     clientId: getRequiredEnv("GOOGLE_CLIENT_ID"),
    //     clientSecret: getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    //   },
    //   github: {
    //     clientId: getRequiredEnv("GITHUB_CLIENT_ID"),
    //     clientSecret: getRequiredEnv("GITHUB_CLIENT_SECRET"),
    //     scope: ["user:email"],
    //   },
    // },
    plugins: [
      crossDomain({ siteUrl }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const actionCtx = requireActionCtx(ctx);
          await resend.sendEmail(actionCtx, {
            from: getRequiredEnv("RESEND_FROM"),
            to: email,
            subject: "Sign in to Stella",
            html: `<p>Click <a href="${url}">here</a> to sign in.</p>`,
          });
        },
      }),
      jwt({
        jwks: {
          keyPairConfig: {
            alg: "RS256",
          },
        },
      }),
      convex({ authConfig, jwksRotateOnTokenGenerationError: true }),
    ],
  } satisfies BetterAuthOptions;

  return options;
};

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx));

const currentUserValidator = v.object({
  id: v.string(),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image: v.optional(v.string()),
});

export const getCurrentUser = query({
  args: {},
  returns: v.union(currentUserValidator, v.null()),
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user || typeof user !== "object") {
      return null;
    }
    const record = user as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) {
      return null;
    }
    return {
      id,
      email: typeof record.email === "string" ? record.email : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      image: typeof record.image === "string" ? record.image : undefined,
    };
  },
});

export const rotateKeys = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    await auth.api.rotateKeys();
    return null;
  },
});

export const requireUserIdentity = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  return identity;
};

export const requireUserId = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  return identity.subject;
};

const loadConversation = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
  conversationId: Id<"conversations">,
) => {
  if ("db" in ctx) {
    return await ctx.db.get(conversationId);
  }
  return await ctx.runQuery(internal.conversations.getById, {
    id: conversationId,
  });
};

export const requireConversationOwner = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return conversation;
};
