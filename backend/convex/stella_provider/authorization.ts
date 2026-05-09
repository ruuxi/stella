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

const TEXT_ONLY_MODALITIES: ("text" | "image" | "audio" | "video" | "pdf")[] = [
  "text",
];

const KNOWN_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

const sanitizeStoredModalities = (
  modalities: readonly string[] | undefined,
): ("text" | "image" | "audio" | "video" | "pdf")[] => {
  if (!modalities || modalities.length === 0) {
    return TEXT_ONLY_MODALITIES;
  }
  const filtered = modalities.filter((m): m is "text" | "image" | "audio" | "video" | "pdf" =>
    KNOWN_MODALITIES.has(m),
  );
  return filtered.length > 0 ? filtered : TEXT_ONLY_MODALITIES;
};

/**
 * Look up a managed model's input modalities from `billing_model_prices`
 * (synced from models.dev). Returns `["text"]` when the row is missing or
 * the modality column hasn't been populated yet, so unknown models drop
 * non-text parts at the gateway boundary instead of forwarding base64
 * data URLs to providers that may tokenize them as raw text.
 */
async function resolveModalitiesInput(
  ctx: ActionCtx,
  model: string,
): Promise<("text" | "image" | "audio" | "video" | "pdf")[]> {
  const row = await ctx.runQuery(internal.billing.getManagedModelPrice, {
    model,
  });
  if (!row) {
    return TEXT_ONLY_MODALITIES;
  }
  return sanitizeStoredModalities(row.modalitiesInput);
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

    if (!subscriptionCheck.allowed) {
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

  // Resolve input modalities from `billing_model_prices` for both the
  // primary and fallback models in parallel. The lookups are tiny indexed
  // queries; doing them at the request boundary keeps `buildManagedModel`
  // synchronous and the rest of the streaming/provider plumbing
  // unchanged.
  const [primaryModalitiesInput, fallbackModalitiesInput] = await Promise.all([
    resolveModalitiesInput(ctx, resolvedModel),
    config.fallback
      ? resolveModalitiesInput(ctx, config.fallback)
      : Promise.resolve(TEXT_ONLY_MODALITIES),
  ]);

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
          modalitiesInput: fallbackModalitiesInput,
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
      modalitiesInput: primaryModalitiesInput,
    },
    fallbackModelConfig,
    anonymousUsageRecord,
  };
}
