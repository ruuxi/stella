import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
} from "../http_shared/cors";
import {
  getAnonDeviceId,
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "../http_shared/anon_device";
import { getClientAddressKey } from "../lib/http_utils";
import { internal } from "../_generated/api";
import {
  buildDashboardPlanUserMessage,
  DASHBOARD_PLAN_SYSTEM_PROMPT,
} from "../prompts/dashboard_plan";
import { planDashboardPagesWithLlm } from "../lib/dashboard_plan_llm";

const MAX_ANON_DASHBOARD_PLAN_REQUESTS = 10;

type PlanDashboardRequest = {
  coreMemory?: string;
};

export const registerDashboardPlanRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/plan-dashboard-pages",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: "/api/plan-dashboard-pages",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        if (!identity && !anonDeviceId) {
          return errorResponse(401, "Unauthorized", origin);
        }

        let body: PlanDashboardRequest | null = null;
        try {
          body = (await request.json()) as PlanDashboardRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const coreMemory = body?.coreMemory?.trim() ?? "";
        if (!coreMemory) {
          return errorResponse(400, "coreMemory is required", origin);
        }

        try {
          if (!identity && anonDeviceId) {
            try {
              const usage = await ctx.runMutation(
                internal.ai_proxy_data.consumeDeviceAllowance,
                {
                  deviceId: anonDeviceId,
                  maxRequests: MAX_ANON_DASHBOARD_PLAN_REQUESTS,
                  clientAddressKey: getClientAddressKey(request) ?? undefined,
                },
              );
              if (!usage.allowed) {
                return errorResponse(
                  429,
                  "Rate limit exceeded. Please create an account for continued access.",
                  origin,
                );
              }
            } catch (error) {
              if (!isAnonDeviceHashSaltMissingError(error)) {
                throw error;
              }
              logMissingSaltOnce("plan-dashboard-pages");
            }
          }

          const ownerId = identity?.subject;

          const pages = await planDashboardPagesWithLlm({
            ctx,
            caller: ownerId
              ? {
                  kind: "owner",
                  ownerId,
                  isAnonymousUser:
                    (identity as Record<string, unknown> | null)?.isAnonymous === true,
                }
              : { kind: "anonymous" },
            coreMemory,
            systemPrompt: DASHBOARD_PLAN_SYSTEM_PROMPT,
            userMessage: buildDashboardPlanUserMessage(coreMemory),
          });

          return jsonResponse({ pages }, 200, origin);
        } catch (error) {
          console.error("[plan-dashboard-pages]", error);
          return errorResponse(500, "Dashboard planning failed", origin);
        }
      }),
    ),
  });
};
