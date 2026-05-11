import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";
import { generateMusic, parseMusicStreamRequest } from "../media_lyria";
import {
  checkManagedUsageLimit,
  scheduleManagedUsage,
} from "../lib/managed_billing";
import { dollarsToMicroCents } from "../lib/billing_money";

const MUSIC_STREAM_PATH = "/api/music/stream";
const MUSIC_KEY_PATH = "/api/music/api-key";
const MUSIC_STREAM_RATE_LIMIT = 10;
const MUSIC_STREAM_RATE_WINDOW_MS = 300_000;

// Lyria 3 Pro Preview pricing as of 2026-05: one song per request.
const LYRIA_USD_PER_SONG = 0.08;
const LYRIA_MODEL_LABEL = "lyria-3-pro-preview";

export const registerMusicRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [MUSIC_STREAM_PATH, MUSIC_KEY_PATH]);

  http.route({
    path: MUSIC_STREAM_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }
        const ownerId = identity.tokenIdentifier;

        const subscriptionCheck = await checkManagedUsageLimit(ctx, ownerId);
        if (!subscriptionCheck.allowed) {
          return errorResponse(429, subscriptionCheck.message, origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "music_stream",
            key: identity.tokenIdentifier,
            limit: MUSIC_STREAM_RATE_LIMIT,
            windowMs: MUSIC_STREAM_RATE_WINDOW_MS,
            blockMs: MUSIC_STREAM_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          return errorResponse(400, "Invalid JSON body.", origin);
        }

        const parsedBody = parseMusicStreamRequest(body);
        if (!parsedBody) {
          return errorResponse(
            400,
            "weightedPrompts and musicGenerationConfig are required.",
            origin,
          );
        }

        const userProvidedKey = await getUserProviderKey(
          ctx,
          ownerId,
          "llm:google",
        );
        const apiKey = userProvidedKey ?? process.env.GOOGLE_AI_API_KEY ?? null;
        // Only meter against the user's plan when Stella's key paid for it —
        // BYO-key callers don't cost Stella anything.
        const billable = !userProvidedKey;
        if (!apiKey) {
          return errorResponse(
            503,
            "No Google AI API key configured. Add one in Settings or contact your administrator.",
            origin,
          );
        }

        const startedAt = Date.now();
        try {
          const result = await generateMusic({
            apiKey,
            parsedBody,
          });

          if (billable) {
            await scheduleManagedUsage(ctx, {
              ownerId,
              agentType: "service:music:lyria",
              model: LYRIA_MODEL_LABEL,
              durationMs: Date.now() - startedAt,
              success: true,
              costMicroCents: dollarsToMicroCents(LYRIA_USD_PER_SONG),
            });
          }

          return withCors(
            Response.json(result, {
              status: 200,
            }),
            origin,
          );
        } catch (error) {
          console.error("[music-generate] Failed to generate music.", {
            message:
              error instanceof Error
                ? error.message
                : "Failed to generate music.",
          });
          return errorResponse(
            502,
            error instanceof Error
              ? error.message
              : "Failed to generate music.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: MUSIC_KEY_PATH,
    method: "POST",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        errorResponse(
          410,
          "Music API keys are no longer exposed to clients. Use /api/music/stream instead.",
          origin,
        ),
      ),
    ),
  });
};
