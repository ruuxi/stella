import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { MANAGED_GATEWAY } from "../agent/model";
import { resolveModelConfig } from "../agent/model_resolver";
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
import {
  resolveManagedModelAccess,
  scheduleManagedUsage,
} from "../lib/managed_billing";
import {
  assistantText,
  completeManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";

type HomeCanvasRequest = {
  systemPrompt: string;
  userPromptTemplate: string;
  coreMemory: string;
  templateFile: string;
};

type HomeCanvasResponse = {
  content: string;
};

const MAX_ANON_REQUESTS = 1_000_000;

export const registerHomeCanvasRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/home-canvas",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: "/api/home-canvas",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        if (!identity && !anonDeviceId) {
          return errorResponse(401, "Unauthorized", origin);
        }

        let body: HomeCanvasRequest | null = null;
        try {
          body = (await request.json()) as HomeCanvasRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const systemPrompt = body?.systemPrompt?.trim();
        const userPromptTemplate = body?.userPromptTemplate?.trim();
        const coreMemory = body?.coreMemory?.trim();
        const templateFile = body?.templateFile?.trim();

        if (!systemPrompt || !userPromptTemplate || !coreMemory || !templateFile) {
          return errorResponse(400, "Missing required fields: systemPrompt, userPromptTemplate, coreMemory, templateFile", origin);
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(`[home-canvas] Missing ${MANAGED_GATEWAY.apiKeyEnvVar} environment variable`);
          return errorResponse(500, "Server configuration error", origin);
        }

        try {
          if (!identity && anonDeviceId) {
            try {
              const usage = await ctx.runMutation(
                internal.ai_proxy_data.consumeDeviceAllowance,
                {
                  deviceId: anonDeviceId,
                  maxRequests: MAX_ANON_REQUESTS,
                  clientAddressKey: getClientAddressKey(request) ?? undefined,
                },
              );
              if (!usage.allowed) {
                return errorResponse(429, "Rate limit exceeded.", origin);
              }
            } catch (error) {
              if (!isAnonDeviceHashSaltMissingError(error)) throw error;
              logMissingSaltOnce("home-canvas");
            }
          }

          const ownerId = identity?.subject;
          const modelAccess = ownerId
            ? await resolveManagedModelAccess(ctx, ownerId, {
                isAnonymous: (identity as Record<string, unknown> | null)?.isAnonymous === true,
              })
            : undefined;
          if (modelAccess && !modelAccess.allowed) {
            return errorResponse(429, modelAccess.message, origin);
          }

          const config = await resolveModelConfig(ctx, "service:home_canvas", ownerId, {
            access: modelAccess,
            audience: ownerId ? undefined : "anonymous",
          });

          // Build the user message by interpolating template
          const userMessage = userPromptTemplate
            .replace("{{coreMemory}}", coreMemory)
            .replace("{{templateFile}}", templateFile);

          const startedAt = Date.now();
          const result = await completeManagedChat({
            config: { ...config, maxOutputTokens: 16192 },
            context: {
              systemPrompt,
              messages: [{
                role: "user",
                content: [{ type: "text", text: userMessage }],
                timestamp: Date.now(),
              }],
            },
          });

          if (ownerId) {
            await scheduleManagedUsage(ctx, {
              ownerId,
              agentType: "service:home_canvas",
              model: config.model,
              durationMs: Date.now() - startedAt,
              success: true,
              usage: usageSummaryFromAssistant(result),
            });
          }

          const content = assistantText(result);
          if (!content) {
            return errorResponse(500, "Failed to generate home canvas content", origin);
          }

          const response: HomeCanvasResponse = { content };
          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[home-canvas] Error:", error);
          return errorResponse(500, "Home canvas generation failed", origin);
        }
      }),
    ),
  });
};
