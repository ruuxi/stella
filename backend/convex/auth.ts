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

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const getEmailLogoSrc = (siteUrl: string) => {
  const custom = process.env.STELLA_EMAIL_LOGO_URL?.trim();
  if (custom) {
    return custom;
  }
  return `${siteUrl.replace(/\/+$/, "")}/stella-logo.svg`;
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
          const logoSrc = escapeHtmlAttribute(getEmailLogoSrc(siteUrl));
          const signInUrl = escapeHtmlAttribute(url);
          await resend.sendEmail(actionCtx, {
            from: getRequiredEnv("RESEND_FROM"),
            to: email,
            subject: "Sign in to Stella",
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f7f8;padding:48px 24px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;">
          <tr>
            <td style="padding-bottom:32px;text-align:center;">
              <img src="${logoSrc}" alt="Stella logo" width="72" height="72" style="display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
              <span style="font-size:16px;font-weight:500;letter-spacing:0.2em;color:#5a5a5a;text-transform:uppercase;">Stella</span>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:32px;">
              <p style="margin:0 0 8px;font-size:16px;font-weight:500;color:#1a1a1a;">Sign in</p>
              <p style="margin:0 0 24px;font-size:14px;color:#6b6b6b;line-height:1.5;">
                Click the button below to sign in to your account. This link will expire in 10 minutes.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${signInUrl}" style="display:inline-block;padding:10px 32px;background-color:#1a1a1a;border-radius:6px;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.04em;">
                      Sign in to Stella
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:12px;color:#999999;line-height:1.5;">
                If you didn't request this email, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
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
