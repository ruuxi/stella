import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ManagedModelAudience } from "../agent/model";
import { errorResponse } from "../http_shared/cors";
import { getClientAddressKey } from "../lib/http_utils";
import {
  resolveManagedGatewayConfig,
  resolveManagedGatewayProvider,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import { resolveManagedModelAccess } from "../lib/managed_billing";
import {
  checkDeviceRateLimit,
  DEFAULT_RETRY_AFTER_MS,
  type AnonymousUsageRecord,
} from "./billing";
import {
  resolveManagedProtocol,
  resolveRequestedStellaModel,
} from "./request";
import {
  parseRequestJson,
  type AuthorizedStellaRequest,
  type ResolvedManagedServerModelConfig,
  type ResolvedStellaModelSelection,
} from "./shared";

function stellaProviderErrorResponse(
  status: number,
  message: string,
  request: Request,
): Response {
  return errorResponse(status, message, request.headers.get("origin"));
}

export async function authorizeStellaRequest(
  ctx: ActionCtx,
  request: Request,
  expectedPath: string,
): Promise<AuthorizedStellaRequest | Response> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.tokenIdentifier;
  const isAnonymous =
    (identity as Record<string, unknown>).isAnonymous === true;
  let modelAudience: ManagedModelAudience = isAnonymous ? "anonymous" : "free";
  let anonymousUsageRecord: AnonymousUsageRecord | undefined;

  const url = new URL(request.url);
  if (!url.pathname.endsWith(expectedPath)) {
    return stellaProviderErrorResponse(
      404,
      "Stella provider path not found",
      request,
    );
  }

  if (isAnonymous) {
    const deviceId = `anon-jwt:${ownerId}`;
    const clientAddressKey = getClientAddressKey(request);
    anonymousUsageRecord = {
      deviceId,
      ...(clientAddressKey ? { clientAddressKey } : {}),
    };
    const allowed = await checkDeviceRateLimit(ctx, deviceId, clientAddressKey);
    if (!allowed) {
      return stellaProviderErrorResponse(
        429,
        "Rate limit exceeded. Please create an account for continued access.",
        request,
      );
    }
  } else {
    const subscriptionCheck = await resolveManagedModelAccess(ctx, ownerId);
    modelAudience = subscriptionCheck.modelAudience;

    const usageBlocked =
      !subscriptionCheck.allowed && subscriptionCheck.plan !== "free";
    if (usageBlocked) {
      const response = stellaProviderErrorResponse(
        429,
        subscriptionCheck.message,
        request,
      );
      response.headers.set(
        "Retry-After",
        String(
          Math.ceil(
            (subscriptionCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000,
          ),
        ),
      );
      return response;
    }

    if (subscriptionCheck.plan !== "free") {
      const rateCheck = await ctx.runMutation(
        internal.ai_proxy_data.checkProxyRateLimit,
        {
          ownerId,
          tokensPerMinuteLimit: subscriptionCheck.tokensPerMinute,
        },
      );

      if (!rateCheck.allowed) {
        const response = stellaProviderErrorResponse(
          429,
          "Rate limit exceeded",
          request,
        );
        response.headers.set(
          "Retry-After",
          String(
            Math.ceil(
              (rateCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000,
            ),
          ),
        );
        return response;
      }
    }
  }

  const requestJson = await parseRequestJson(request);
  if (!requestJson) {
    return stellaProviderErrorResponse(
      400,
      "Stella request body must be valid JSON",
      request,
    );
  }

  const headerAgentType = request.headers.get("X-Stella-Agent-Type")?.trim();
  const bodyAgentType =
    typeof requestJson.agentType === "string" &&
    requestJson.agentType.trim().length > 0
      ? requestJson.agentType.trim()
      : undefined;
  const agentType = headerAgentType || bodyAgentType || "general";

  let selection: ResolvedStellaModelSelection;
  try {
    selection = resolveRequestedStellaModel(
      agentType,
      requestJson,
      modelAudience,
    );
  } catch (error) {
    return stellaProviderErrorResponse(
      400,
      error instanceof Error ? error.message : "Invalid Stella model selection",
      request,
    );
  }

  const { requestedModel, resolvedModel, config } = selection;
  const managedGatewayProvider: ManagedGatewayProvider =
    resolveManagedGatewayProvider({
      model: resolvedModel,
      configuredProvider: config.managedGatewayProvider,
    });
  const managedGateway = resolveManagedGatewayConfig({
    model: resolvedModel,
    configuredProvider: config.managedGatewayProvider,
  });
  if (!process.env[managedGateway.apiKeyEnvVar]?.trim()) {
    return stellaProviderErrorResponse(
      503,
      "Stella upstream gateway is not configured",
      request,
    );
  }

  const managedApi = resolveManagedProtocol({
    resolvedModel,
    managedGatewayProvider,
  });

  console.log(
    `[stella-provider] agent=${agentType} | requestedModel=${requestedModel} | resolvedModel=${resolvedModel} | fallbackModel=${config.fallback ?? "none"} | gateway=${managedGatewayProvider} | api=${managedApi}`,
  );

  const fallbackModelConfig: ResolvedManagedServerModelConfig | undefined =
    config.fallback
      ? {
          model: config.fallback,
          managedGatewayProvider: resolveManagedGatewayProvider({
            model: config.fallback,
            configuredProvider: config.fallbackManagedGatewayProvider,
          }),
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          providerOptions: config.fallbackProviderOptions as
            | Record<string, Record<string, unknown>>
            | undefined,
        }
      : undefined;

  return {
    ownerId,
    agentType,
    requestJson,
    requestedModel,
    resolvedModel,
    managedApi,
    serverModelConfig: {
      model: resolvedModel,
      managedGatewayProvider,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      providerOptions: config.providerOptions as
        | Record<string, Record<string, unknown>>
        | undefined,
    },
    fallbackModelConfig,
    anonymousUsageRecord,
  };
}
