import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MUSIC_KEY_RATE_LIMIT = 10;
const MUSIC_KEY_RATE_WINDOW_MS = 300_000;

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerMusicRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/music/api-key",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/music/api-key",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        // Require authenticated user (no anonymous access for API key distribution)
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "music_api_key",
            key: identity.subject,
            limit: MUSIC_KEY_RATE_LIMIT,
            windowMs: MUSIC_KEY_RATE_WINDOW_MS,
            blockMs: MUSIC_KEY_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        // Resolve Google AI API key via BYOK chain, then platform env var
        const ownerId = identity.subject;
        const apiKey =
          await getUserProviderKey(ctx, ownerId, "llm:google") ??
          process.env.GOOGLE_AI_API_KEY ??
          null;

        if (!apiKey) {
          return errorResponse(
            503,
            "No Google AI API key configured. Add one in Settings or contact your administrator.",
            origin,
          );
        }

        return jsonResponse({ apiKey }, 200, origin);
      }),
    ),
  });
};
