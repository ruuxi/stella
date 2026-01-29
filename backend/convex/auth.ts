import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { jwt, magicLink } from "better-auth/plugins";
import { query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import authConfig from "./auth.config";

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

export const authComponent = createClient<DataModel>(components.betterAuth);
const resend = new Resend(components.resend);

export const createAuthOptions = (
  ctx: GenericCtx<DataModel>,
): BetterAuthOptions => {
  const siteUrl = getRequiredEnv("SITE_URL");
  const convexSiteUrl = getRequiredEnv("CONVEX_SITE_URL");
  const trustedOrigins = Array.from(
    new Set(
      [siteUrl, ...extraTrustedOrigins].filter((origin): origin is string =>
        Boolean(origin),
      ),
    ),
  );

  return {
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
        sendMagicLink: requireActionCtx(async ({ email, url }, actionCtx) => {
          await resend.sendEmail(actionCtx, {
            from: getRequiredEnv("RESEND_FROM"),
            to: email,
            subject: "Sign in to Stellar",
            html: `<p>Click <a href="${url}">here</a> to sign in.</p>`,
          });
        }),
      }),
      jwt(),
      convex({ authConfig, jwksRotateOnTokenGenerationError: true }),
    ],
  };
};

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx));

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
});

export const requireUserIdentity = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
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
  return await ctx.runQuery(internal.conversations.getById, { id: conversationId });
};

export const requireConversationOwner = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new Error("Conversation not found");
  }
  return conversation;
};
