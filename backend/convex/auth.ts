import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { anonymous, jwt, magicLink } from "better-auth/plugins";
import {
  internalAction,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { ConvexError, v } from "convex/values";
import betterAuthSchema from "./betterAuth/schema";
import { buildMagicLinkEmail } from "./lib/email_templates";
import { appReviewAuth } from "./lib/app_review_auth";
import {
  enforceMutationRateLimit,
  RATE_SENSITIVE,
} from "./lib/rate_limits";

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

/**
 * Map a Better Auth `user.id` to the Convex `UserIdentity.tokenIdentifier`
 * shape (`${issuer}|${subject}`). Use this anywhere we have a Better Auth
 * `user.id` but no live `UserIdentity` (lifecycle hooks, JWT payload builder,
 * Stripe webhooks, etc.) so the value matches what `requireUserId` and friends
 * return inside Convex functions.
 */
export const tokenIdentifierForBetterAuthUserId = (userId: string) =>
  `${getRequiredEnv("CONVEX_SITE_URL")}|${userId}`;

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
  "http://localhost:57314",
  "http://localhost:5715",
  // Expo web (`expo start --web` / press `w`) defaults to port 8081
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "https://stella.sh",
  // Mobile WebView loads the desktop UI via Cloudflare tunnel
  "*.stellatunnel.com",
];

const getDeepLinkOrigin = () => {
  const raw = process.env.STELLA_PROTOCOL;
  if (!raw) {
    return "Stella://auth";
  }
  const protocol = raw.replace("://", "").replace(":", "");
  return `${protocol}://auth`;
};

/** Matches `EXPO_PUBLIC_STELLA_MOBILE_SCHEME` default in `mobile/src/config/env.ts` (magic-link callback). */
const getMobileDeepLinkOrigins = () => {
  const scheme =
    process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim()
    || process.env.STELLA_MOBILE_SCHEME?.trim()
    || "stella-mobile";
  // expoClient sends `Linking.createURL("", { scheme })` as expo-origin,
  // which varies by platform (e.g. "stella-mobile://", "stella-mobile:///").
  // Include both with and without the /auth path.
  return [`${scheme}://auth`, `${scheme}://`, `${scheme}:///`];
};

const DEFAULT_SESSION_VERSION = 1;
const JWT_EXPIRATION_TIME = process.env.STELLA_JWT_EXPIRATION?.trim() || "5m";

const sessionPolicyValidator = v.object({
  sessionVersion: v.number(),
  minIssuedAtSec: v.optional(v.number()),
  updatedAt: v.number(),
});

const parseNumericClaim = (
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
  claim: string,
): number | null => {
  if (!identity || typeof identity !== "object") {
    return null;
  }
  const value = (identity as Record<string, unknown>)[claim];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

export const authComponent = createClient<DataModel, typeof betterAuthSchema>(
  components.betterAuth,
  {
    local: {
      schema: betterAuthSchema,
    },
  },
);
const resend = new Resend(components.resend, { testMode: false });

const getSessionPolicyFromDb = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
) => {
  const policy = await ctx.db
    .query("auth_session_policies")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (!policy) {
    return null;
  }
  return {
    sessionVersion: policy.sessionVersion,
    minIssuedAtSec: policy.minIssuedAtSec,
    updatedAt: policy.updatedAt,
  };
};

const getSessionPolicyForOwnerAction = async (
  ctx: ActionCtx,
  ownerId: string,
) => {
  return await ctx.runQuery(internal.auth.getSessionPolicyByOwnerInternal, {
    ownerId,
  });
};

const getSessionVersionForOwner = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
): Promise<number> => {
  const policy = await getSessionPolicyFromDb(ctx, ownerId);
  return policy?.sessionVersion ?? DEFAULT_SESSION_VERSION;
};

const getSessionVersionForOwnerAction = async (
  ctx: ActionCtx,
  ownerId: string,
): Promise<number> => {
  const policy = await ctx.runQuery(internal.auth.getSessionPolicyByOwnerInternal, {
    ownerId,
  });
  return policy?.sessionVersion ?? DEFAULT_SESSION_VERSION;
};

export const assertSensitiveSessionPolicy = async (
  ctx: QueryCtx | MutationCtx,
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
) => {
  if (!identity) return;
  const policy = await getSessionPolicyFromDb(ctx, identity.tokenIdentifier);
  if (!policy) return;

  const tokenVersion =
    parseNumericClaim(identity, "stellaSessionVersion") ??
    DEFAULT_SESSION_VERSION;
  if (tokenVersion < policy.sessionVersion) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Session version is outdated. Please sign in again.",
    });
  }

  if (policy.minIssuedAtSec !== undefined) {
    const issuedAtSec = parseNumericClaim(identity, "iat");
    if (issuedAtSec === null || issuedAtSec < policy.minIssuedAtSec) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Session has been revoked. Please sign in again.",
      });
    }
  }
};

export const assertSensitiveSessionPolicyAction = async (
  ctx: ActionCtx,
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
) => {
  if (!identity) return;
  const policy = await getSessionPolicyForOwnerAction(ctx, identity.tokenIdentifier);
  if (!policy) return;

  const tokenVersion =
    parseNumericClaim(identity, "stellaSessionVersion") ??
    DEFAULT_SESSION_VERSION;
  if (tokenVersion < policy.sessionVersion) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Session version is outdated. Please sign in again.",
    });
  }

  if (policy.minIssuedAtSec !== undefined) {
    const issuedAtSec = parseNumericClaim(identity, "iat");
    if (issuedAtSec === null || issuedAtSec < policy.minIssuedAtSec) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Session has been revoked. Please sign in again.",
      });
    }
  }
};

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = getRequiredEnv("SITE_URL");
  const convexSiteUrl = getRequiredEnv("CONVEX_SITE_URL");
  const trustedOrigins = Array.from(
    new Set(
      [
        siteUrl,
        getDeepLinkOrigin(),
        ...getMobileDeepLinkOrigins(),
        ...extraTrustedOrigins,
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  );

  const options = {
    baseURL: convexSiteUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const actionCtx = requireActionCtx(ctx);
          await actionCtx.runAction(internal.account_deletion.purgeOwnerCloudData, {
            ownerId: tokenIdentifierForBetterAuthUserId(user.id),
          });
        },
      },
    },
    // Social providers are disabled until OAuth onboarding is implemented.
    // Enable by setting GOOGLE_CLIENT_ID/SECRET and GITHUB_CLIENT_ID/SECRET env vars.
    plugins: [
      crossDomain({ siteUrl }),
      anonymous({
        emailDomainName: "anon.stella.local",
        disableDeleteAnonymousUser: true,
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          const actionCtx = requireActionCtx(ctx);
          await actionCtx.scheduler.runAfter(
            0,
            internal.auth_migration.migrateOwnership,
            {
              fromOwnerId: tokenIdentifierForBetterAuthUserId(anonymousUser.user.id),
              toOwnerId: tokenIdentifierForBetterAuthUserId(newUser.user.id),
            },
          );
        },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const actionCtx = requireActionCtx(ctx);
          const logoSrc = escapeHtmlAttribute(getEmailLogoSrc(siteUrl));
          const signInUrl = escapeHtmlAttribute(url);
          await resend.sendEmail(actionCtx, {
            from: getRequiredEnv("RESEND_FROM"),
            to: email,
            subject: "Sign in to Stella",
            html: buildMagicLinkEmail(logoSrc, signInUrl),
          });
        },
      }),
      appReviewAuth(),
      jwt({
        jwks: {
          keyPairConfig: {
            alg: "RS256",
          },
        },
        jwt: {
          expirationTime: JWT_EXPIRATION_TIME,
          definePayload: async (session) => {
            const ownerId = tokenIdentifierForBetterAuthUserId(session.user.id);
            const sessionVersion =
              "db" in ctx
                ? await getSessionVersionForOwner(
                    ctx as QueryCtx | MutationCtx,
                    ownerId,
                  )
                : await getSessionVersionForOwnerAction(
                    ctx as unknown as ActionCtx,
                    ownerId,
                  );
            return {
              ...session.user,
              stellaSessionVersion: sessionVersion,
            };
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
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      isAnonymous: v.optional(v.boolean()),
    }),
  ),
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
      isAnonymous: record.isAnonymous === true ? true : undefined,
    };
  },
});

export const rotateKeys = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    await auth.api.rotateKeys();
    return null;
  },
});

export const getSessionPolicyByOwnerInternal = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const policy = await ctx.db
      .query("auth_session_policies")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (!policy) {
      return null;
    }
    return {
      sessionVersion: policy.sessionVersion,
      minIssuedAtSec: policy.minIssuedAtSec,
      updatedAt: policy.updatedAt,
    };
  },
});

export const getSessionPolicy = query({
  args: {},
  returns: sessionPolicyValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const policy = await getSessionPolicyFromDb(ctx, ownerId);
    return (
      policy ?? {
        sessionVersion: DEFAULT_SESSION_VERSION,
        updatedAt: 0,
      }
    );
  },
});

const upsertSessionPolicy = async (
  ctx: MutationCtx,
  ownerId: string,
  patch: { sessionVersion?: number; minIssuedAtSec?: number },
) => {
  const now = Date.now();
  const existing = await ctx.db
    .query("auth_session_policies")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (existing) {
    const next = {
      sessionVersion: patch.sessionVersion ?? existing.sessionVersion,
      minIssuedAtSec: patch.minIssuedAtSec ?? existing.minIssuedAtSec,
      updatedAt: now,
    };
    await ctx.db.patch(existing._id, next);
    return next;
  }

  const created = {
    ownerId,
    sessionVersion: patch.sessionVersion ?? DEFAULT_SESSION_VERSION,
    minIssuedAtSec: patch.minIssuedAtSec,
    updatedAt: now,
  };
  await ctx.db.insert("auth_session_policies", created);
  return {
    sessionVersion: created.sessionVersion,
    minIssuedAtSec: created.minIssuedAtSec,
    updatedAt: created.updatedAt,
  };
};

export const revokeActiveSessions = mutation({
  args: {},
  returns: sessionPolicyValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    // Sensitive op: invalidates JWTs for the whole account. A hijacked
    // session shouldn't be able to churn this either.
    await enforceMutationRateLimit(
      ctx,
      "auth_revoke_active_sessions",
      ownerId,
      RATE_SENSITIVE,
      "Too many session revocation requests. Please wait a minute and try again.",
    );
    const minIssuedAtSec = Math.floor(Date.now() / 1000);
    return await upsertSessionPolicy(ctx, ownerId, { minIssuedAtSec });
  },
});

export const bumpSessionVersion = mutation({
  args: {},
  returns: sessionPolicyValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "auth_bump_session_version",
      ownerId,
      RATE_SENSITIVE,
      "Too many session version bumps. Please wait a minute and try again.",
    );
    const existing = await getSessionPolicyFromDb(ctx, ownerId);
    const nextVersion = (existing?.sessionVersion ?? DEFAULT_SESSION_VERSION) + 1;
    const minIssuedAtSec = Math.floor(Date.now() / 1000);
    return await upsertSessionPolicy(ctx, ownerId, {
      sessionVersion: nextVersion,
      minIssuedAtSec,
    });
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
  return identity.tokenIdentifier;
};

export const isAnonymousIdentity = (identity: unknown): boolean =>
  Boolean(
    identity
    && typeof identity === "object"
    && (identity as Record<string, unknown>).isAnonymous === true,
  );

export const requireConnectedUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use this feature.",
    });
  }
  return identity;
};

export const requireConnectedUserIdentityAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use this feature.",
    });
  }
  return identity;
};

export const requireConnectedUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireConnectedUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const requireConnectedUserIdAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireConnectedUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicy(ctx, identity);
  return identity;
};

export const requireSensitiveUserIdentityAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicyAction(ctx, identity);
  return identity;
};

export const requireSensitiveUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireSensitiveUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireSensitiveUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

const loadConversation = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  return await ctx.db.get(conversationId);
};

const loadConversationAction = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
) => {
  return await ctx.runQuery(internal.conversations.getById, {
    id: conversationId,
  });
};

/**
 * Non-throwing variant: returns the conversation if the current user owns it,
 * or null when the conversation doesn't exist / belongs to someone else.
 * Use this in queries/mutations that intentionally return null for unauthorized access
 * instead of throwing (e.g. polling endpoints, optional lookups).
 */
export const tryLoadOwnedConversation = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    return null;
  }
  return conversation;
};

export const requireConversationOwner = async (
  ctx: QueryCtx | MutationCtx,
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

export const requireConversationOwnerAction = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversationAction(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return conversation;
};
