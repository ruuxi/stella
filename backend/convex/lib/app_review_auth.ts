import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { APIError } from "better-call";
import * as z from "zod";

const REVIEW_SIGN_IN_PATH = "/review/sign-in";
const DEFAULT_REVIEW_NAME = "App Review";

const reviewSignInBodySchema = z.object({
  email: z.string().email(),
});

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export const getAppReviewEmail = () =>
  normalizeEmail(process.env.APP_REVIEW_EMAIL?.trim() ?? "");

const getAppReviewName = () => process.env.APP_REVIEW_NAME?.trim() || DEFAULT_REVIEW_NAME;

const ensureReviewUser = async (
  ctx: Parameters<NonNullable<BetterAuthPlugin["endpoints"]>[string]>[0],
  email: string,
) => {
  const existing = await ctx.context.internalAdapter.findUserByEmail(email);
  if (!existing?.user) {
    return await ctx.context.internalAdapter.createUser({
      email,
      emailVerified: true,
      name: getAppReviewName(),
    });
  }

  const shouldPatch =
    existing.user.emailVerified !== true || existing.user.name !== getAppReviewName();
  if (!shouldPatch) {
    return existing.user;
  }

  return await ctx.context.internalAdapter.updateUser(existing.user.id, {
    emailVerified: true,
    name: getAppReviewName(),
  });
};

export const appReviewAuth = (): BetterAuthPlugin => ({
  id: "app-review-auth",
  endpoints: {
    signInAppReview: createAuthEndpoint(
      REVIEW_SIGN_IN_PATH,
      {
        method: "POST",
        body: reviewSignInBodySchema,
        metadata: {
          openapi: {
            operationId: "signInAppReview",
            description: "Sign in with the shared App Review account",
            responses: {
              200: {
                description: "App Review session created",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        user: { $ref: "#/components/schemas/User" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (ctx) => {
        const reviewEmail = getAppReviewEmail();
        if (!reviewEmail) {
          throw new APIError("NOT_FOUND", {
            message: "App Review sign-in is not configured.",
          });
        }

        const requestedEmail = normalizeEmail(ctx.body.email);
        if (requestedEmail !== reviewEmail) {
          throw new APIError("NOT_FOUND", {
            message: "Review account not found.",
          });
        }

        const user = await ensureReviewUser(ctx, reviewEmail);
        if (!user) {
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Failed to create the App Review account.",
          });
        }

        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Failed to create the App Review session.",
          });
        }

        await setSessionCookie(ctx, { session, user });

        return ctx.json({
          user: {
            id: user.id,
            email: user.email,
            emailVerified: user.emailVerified,
            name: user.name,
            image: user.image,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        });
      },
    ),
  },
  rateLimit: [{
    pathMatcher(path) {
      return path.startsWith(REVIEW_SIGN_IN_PATH);
    },
    window: 60,
    max: 10,
  }],
});
