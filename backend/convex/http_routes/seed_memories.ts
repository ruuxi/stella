import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  jsonResponse,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerSeedMemoryRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/seed-memories",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/seed-memories",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        try {
          const body = (await request.json()) as {
            formattedSignals?: string;
          };
          if (!body?.formattedSignals) {
            return errorResponse(400, "Missing formattedSignals", origin);
          }

          // Schedule seeding as async action (non-blocking)
          await ctx.scheduler.runAfter(
            0,
            internal.data.memory.seedFromDiscovery,
            {
              ownerId: identity.subject,
              formattedSignals: body.formattedSignals,
            },
          );

          return jsonResponse({ ok: true }, 200, origin);
        } catch (error) {
          console.error("[seed-memories] Error:", error);
          return errorResponse(500, "Seed failed", origin);
        }
      }),
    ),
  });
};
