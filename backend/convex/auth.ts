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
import { ConvexError } from "convex/values";

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
  const raw = process.env.STELLAR_PROTOCOL;
  if (!raw) {
    return "stellar://auth";
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
      [siteUrl, getDeepLinkOrigin(), ...extraTrustedOrigins].filter((origin): origin is string =>
        Boolean(origin),
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
            subject: "Sign in to Stellar",
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

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
});

export const rotateKeys = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    return await auth.api.rotateKeys();
  },
});

export const requireUserIdentity = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
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
    throw new ConvexError({ code: "NOT_FOUND", message: "Conversation not found" });
  }
  return conversation;
};
