import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  withCors,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";
import { getModelConfig, MANAGED_GATEWAY } from "../agent/model";
import {
  MEDIA_SDK_DOCS_MARKDOWN_PATH,
  MEDIA_SDK_DOCS_PATH,
  MEDIA_SDK_JOB_CANCEL_PATH,
  MEDIA_SDK_JOB_RESULT_PATH,
  MEDIA_SDK_JOB_STATUS_PATH,
  MEDIA_SDK_JOBS_PATH,
  getMediaService,
} from "../media_sdk_catalog";
import { buildMediaSdkDocument } from "../media_sdk_docs";
import {
  cancelFalJob,
  getFalJobResult,
  getFalJobStatus,
  submitFalJob,
} from "../media_sdk_fal";
import { createMediaJobTicket, parseMediaJobTicket } from "../media_sdk_tickets";

const SUBMIT_RATE_LIMIT = 24;
const JOB_READ_RATE_LIMIT = 120;
const MEDIA_RATE_WINDOW_MS = 60_000;

type MediaRequestBody = {
  service?: unknown;
  input?: unknown;
  options?: unknown;
  variant?: unknown;
  messages?: unknown;
  prompt?: unknown;
  imageUrl?: unknown;
  videoUrl?: unknown;
  audioUrl?: unknown;
  referenceImageUrl?: unknown;
  text?: unknown;
  voice?: unknown;
  temperature?: unknown;
  maxOutputTokens?: unknown;
};

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const extractChatText = (payload: Record<string, unknown>): string => {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  const firstChoice = asObject(choices[0]);
  const message = asObject(firstChoice?.message);
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => asObject(part)?.text)
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
};

const consumeRateLimit = async (
  ctx: any,
  args: { scope: string; key: string; limit: number },
) =>
  await ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
    scope: args.scope,
    key: args.key,
    limit: args.limit,
    windowMs: MEDIA_RATE_WINDOW_MS,
    blockMs: MEDIA_RATE_WINDOW_MS,
  });

const buildConvenienceInput = (
  body: MediaRequestBody,
): Record<string, unknown> => {
  const rawInput = asObject(body.input);
  const base = rawInput ? { ...rawInput } : {};

  const prompt = asTrimmedString(body.prompt);
  if (prompt && base.prompt === undefined) {
    base.prompt = prompt;
  }

  const text = asTrimmedString(body.text);
  if (text && base.text === undefined) {
    base.text = text;
  }

  const voice = asTrimmedString(body.voice);
  if (voice && base.voice === undefined) {
    base.voice = voice;
  }

  const imageUrl = asTrimmedString(body.imageUrl);
  if (imageUrl && base.image_url === undefined) {
    base.image_url = imageUrl;
  }

  const referenceImageUrl = asTrimmedString(body.referenceImageUrl);
  if (referenceImageUrl && base.reference_image_url === undefined) {
    base.reference_image_url = referenceImageUrl;
  }

  const videoUrl = asTrimmedString(body.videoUrl);
  if (videoUrl && base.video_url === undefined) {
    base.video_url = videoUrl;
  }

  const audioUrl = asTrimmedString(body.audioUrl);
  if (audioUrl && base.audio_url === undefined) {
    base.audio_url = audioUrl;
  }

  if (Array.isArray(body.messages) && base.messages === undefined) {
    base.messages = body.messages;
  }

  delete base.model;
  return base;
};

const buildGatewayBody = (args: {
  modelId: string;
  providerOptions?: Record<string, Record<string, unknown>>;
  body: MediaRequestBody;
}): Record<string, unknown> => {
  const payload = buildConvenienceInput(args.body);

  if (!Array.isArray(payload.messages) && typeof payload.prompt === "string") {
    payload.messages = [
      {
        role: "user",
        content: payload.prompt,
      },
    ];
  }

  if (
    typeof args.body.temperature === "number" &&
    Number.isFinite(args.body.temperature) &&
    payload.temperature === undefined
  ) {
    payload.temperature = args.body.temperature;
  }

  if (
    typeof args.body.maxOutputTokens === "number" &&
    Number.isFinite(args.body.maxOutputTokens) &&
    payload.max_completion_tokens === undefined &&
    payload.max_tokens === undefined
  ) {
    payload.max_completion_tokens = Math.floor(args.body.maxOutputTokens);
  }

  payload.model = args.modelId;

  if (args.providerOptions) {
    for (const [key, value] of Object.entries(args.providerOptions)) {
      payload[key] = value;
    }
  }

  return payload;
};

const executeManagedChat = async (args: {
  body: MediaRequestBody;
  modelId: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}): Promise<Record<string, unknown>> => {
  const gatewayKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar]?.trim();
  if (!gatewayKey) {
    throw new Error("Stella upstream gateway is not configured");
  }

  const response = await fetch(`${MANAGED_GATEWAY.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gatewayKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(
      buildGatewayBody({
        body: args.body,
        modelId: args.modelId,
        providerOptions: args.providerOptions,
      }),
    ),
  });

  const text = await response.text();
  let json: Record<string, unknown>;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Managed chat returned invalid JSON");
  }

  if (!response.ok) {
    throw new Error(`Managed chat request failed: ${response.status}`);
  }

  return json;
};

const resolveLlmModelId = (serviceId: string, variant: string | null): string => {
  if (serviceId === "media-llm") {
    return getModelConfig("media_llm").model;
  }
  if (variant === "fast") {
    return getModelConfig("llm_fast").model;
  }
  return getModelConfig("llm_best").model;
};

const resolveLlmProviderOptions = (
  serviceId: string,
  variant: string | null,
): Record<string, Record<string, unknown>> | undefined => {
  if (serviceId === "media-llm") {
    return getModelConfig("media_llm").providerOptions as
      | Record<string, Record<string, unknown>>
      | undefined;
  }
  if (variant === "fast") {
    return getModelConfig("llm_fast").providerOptions as
      | Record<string, Record<string, unknown>>
      | undefined;
  }
  return getModelConfig("llm_best").providerOptions as
    | Record<string, Record<string, unknown>>
    | undefined;
};

const resolveMusicApiKey = async (
  ctx: any,
  ownerId: string,
): Promise<string | null> =>
  (await getUserProviderKey(ctx, ownerId, "llm:google")) ??
  process.env.GOOGLE_AI_API_KEY ??
  null;

const resolveJobIdFromRequest = (
  request: Request,
  source: "query" | "body",
  body?: Record<string, unknown> | null,
): string | null => {
  if (source === "body") {
    return asTrimmedString(body?.jobId);
  }
  return asTrimmedString(new URL(request.url).searchParams.get("jobId"));
};

export const registerMediaSdkRoutes = (http: HttpRouter) => {
  const preflight = httpAction(async (_ctx, request) =>
    corsPreflightHandler(request),
  );

  http.route({ path: MEDIA_SDK_DOCS_PATH, method: "OPTIONS", handler: preflight });
  http.route({
    path: MEDIA_SDK_DOCS_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        jsonResponse(buildMediaSdkDocument(origin).json, 200, origin),
      ),
    ),
  });

  http.route({ path: MEDIA_SDK_DOCS_MARKDOWN_PATH, method: "OPTIONS", handler: preflight });
  http.route({
    path: MEDIA_SDK_DOCS_MARKDOWN_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const { markdown } = buildMediaSdkDocument(origin);
        return withCors(
          new Response(markdown, {
            status: 200,
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
            },
          }),
          origin,
        );
      }),
    ),
  });

  http.route({ path: MEDIA_SDK_JOBS_PATH, method: "OPTIONS", handler: preflight });
  http.route({
    path: MEDIA_SDK_JOBS_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await consumeRateLimit(ctx, {
          scope: "media_sdk_submit",
          key: identity.subject,
          limit: SUBMIT_RATE_LIMIT,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: MediaRequestBody | null = null;
        try {
          body = (await request.json()) as MediaRequestBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const serviceId = asTrimmedString(body?.service);
        if (!serviceId) {
          return errorResponse(400, "service is required", origin);
        }

        const service = getMediaService(serviceId);
        if (!service) {
          return errorResponse(404, `Unknown media service: ${serviceId}`, origin);
        }

        try {
          if (service.transport === "fal_queue") {
            const input = buildConvenienceInput(body ?? {});
            const options = asObject(body?.options);
            const submit = await submitFalJob({
              service,
              input,
              options: {
                logs: options?.logs === true,
                webhookUrl: asTrimmedString(options?.webhookUrl) ?? undefined,
              },
            });
            const jobId = await createMediaJobTicket({
              ownerId: identity.subject,
              serviceId: service.id,
              transport: "fal_queue",
              requestId: submit.requestId as string,
              endpointId: service.hiddenUpstreamId!,
              issuedAt: Date.now(),
            });

            return jsonResponse(
              {
                ok: true,
                mode: "async",
                service: service.id,
                job: {
                  id: jobId,
                  statusUrl: `${MEDIA_SDK_JOB_STATUS_PATH}?jobId=${encodeURIComponent(jobId)}`,
                  resultUrl: `${MEDIA_SDK_JOB_RESULT_PATH}?jobId=${encodeURIComponent(jobId)}`,
                  cancelUrl: MEDIA_SDK_JOB_CANCEL_PATH,
                },
                upstream: submit,
              },
              200,
              origin,
            );
          }

          if (service.transport === "music_api_key") {
            const apiKey = await resolveMusicApiKey(ctx, identity.subject);
            if (!apiKey) {
              return errorResponse(
                503,
                "No Google AI API key configured for music",
                origin,
              );
            }

            return jsonResponse(
              {
                ok: true,
                mode: "sync",
                service: service.id,
                output: {
                  apiKey,
                },
              },
              200,
              origin,
            );
          }

          const variant = asTrimmedString(body?.variant);
          const raw = await executeManagedChat({
            body,
            modelId: resolveLlmModelId(service.id, variant),
            providerOptions: resolveLlmProviderOptions(service.id, variant),
          });

          return jsonResponse(
            {
              ok: true,
              mode: "sync",
              service: service.id,
              ...(variant ? { variant } : {}),
              text: extractChatText(raw),
              output: raw,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[media-sdk/jobs] Error:", error);
          return errorResponse(
            500,
            error instanceof Error ? error.message : "Media job failed",
            origin,
          );
        }
      }),
    ),
  });

  http.route({ path: MEDIA_SDK_JOB_STATUS_PATH, method: "OPTIONS", handler: preflight });
  http.route({
    path: MEDIA_SDK_JOB_STATUS_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await consumeRateLimit(ctx, {
          scope: "media_sdk_status",
          key: identity.subject,
          limit: JOB_READ_RATE_LIMIT,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const jobId = resolveJobIdFromRequest(request, "query");
        if (!jobId) {
          return errorResponse(400, "jobId is required", origin);
        }

        const ticket = await parseMediaJobTicket(jobId);
        if (!ticket) {
          return errorResponse(400, "Invalid media job token", origin);
        }
        if (ticket.ownerId !== identity.subject) {
          return errorResponse(403, "This media job does not belong to you", origin);
        }

        try {
          const output = await getFalJobStatus({
            endpointId: ticket.endpointId,
            requestId: ticket.requestId,
            logs: true,
          });
          return jsonResponse(
            {
              ok: true,
              jobId,
              service: ticket.serviceId,
              output,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[media-sdk/status] Error:", error);
          return errorResponse(
            500,
            error instanceof Error ? error.message : "Media job request failed",
            origin,
          );
        }
      }),
    ),
  });

  http.route({ path: MEDIA_SDK_JOB_RESULT_PATH, method: "OPTIONS", handler: preflight });
  http.route({
    path: MEDIA_SDK_JOB_RESULT_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await consumeRateLimit(ctx, {
          scope: "media_sdk_result",
          key: identity.subject,
          limit: JOB_READ_RATE_LIMIT,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const jobId = resolveJobIdFromRequest(request, "query");
        if (!jobId) {
          return errorResponse(400, "jobId is required", origin);
        }

        const ticket = await parseMediaJobTicket(jobId);
        if (!ticket) {
          return errorResponse(400, "Invalid media job token", origin);
        }
        if (ticket.ownerId !== identity.subject) {
          return errorResponse(403, "This media job does not belong to you", origin);
        }

        try {
          const output = await getFalJobResult({
            endpointId: ticket.endpointId,
            requestId: ticket.requestId,
          });
          return jsonResponse(
            {
              ok: true,
              jobId,
              service: ticket.serviceId,
              output,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[media-sdk/result] Error:", error);
          return errorResponse(
            500,
            error instanceof Error ? error.message : "Media job request failed",
            origin,
          );
        }
      }),
    ),
  });

  http.route({ path: MEDIA_SDK_JOB_CANCEL_PATH, method: "OPTIONS", handler: preflight });
  http.route({
    path: MEDIA_SDK_JOB_CANCEL_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await consumeRateLimit(ctx, {
          scope: "media_sdk_cancel",
          key: identity.subject,
          limit: JOB_READ_RATE_LIMIT,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: Record<string, unknown> | null = null;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const jobId = resolveJobIdFromRequest(request, "body", body);
        if (!jobId) {
          return errorResponse(400, "jobId is required", origin);
        }

        const ticket = await parseMediaJobTicket(jobId);
        if (!ticket) {
          return errorResponse(400, "Invalid media job token", origin);
        }
        if (ticket.ownerId !== identity.subject) {
          return errorResponse(403, "This media job does not belong to you", origin);
        }

        try {
          const output = await cancelFalJob({
            endpointId: ticket.endpointId,
            requestId: ticket.requestId,
          });
          return jsonResponse(
            {
              ok: true,
              jobId,
              service: ticket.serviceId,
              canceled: true,
              output,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[media-sdk/cancel] Error:", error);
          return errorResponse(
            500,
            error instanceof Error ? error.message : "Media job request failed",
            origin,
          );
        }
      }),
    ),
  });
};
