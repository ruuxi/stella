import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  withCors,
} from "../http_shared/cors";
import {
  consumeWebhookDedup,
  rateLimitResponse,
} from "../http_shared/webhook_controls";
import {
  listMediaCapabilities,
  resolveMediaProfile,
  type MediaCapability,
} from "../media_catalog";
import {
  MEDIA_JOB_STATUS_VALUES,
  createMediaGenerateAcceptedResponse,
  createMediaGenerateRequestExample,
  createMediaJobError,
  createMediaJobResponse,
  type MediaJobStatus,
  parseMediaGenerateRequest,
} from "../media_contract";
import {
  PUBLIC_MEDIA_TEST_OWNER_ID,
  isMediaPublicTestModeEnabled,
  summarizeMediaRequestForStorage,
} from "../media_jobs";
import {
  buildFalResponseUrl,
  fetchFalResultPayload,
  getFalApiKey,
  submitFalRequest,
  verifyFalWebhookSignature,
} from "../media_fal_webhooks";
import { hashSha256Hex } from "../lib/crypto_utils";
import { isRecord } from "../shared_validators";
import {
  getMediaBillingAdmissionIssue,
  meterCompletedMediaJob,
} from "../media_billing";
import {
  checkManagedUsageLimit,
} from "../lib/managed_billing";
import { dollarsToMicroCents } from "../lib/billing_money";
import {
  MEDIA_REALTIME_ENDPOINT_ID,
  MEDIA_REALTIME_HEARTBEAT_TIMEOUT_MS,
} from "../media_realtime_sessions";

const MEDIA_API_BASE_PATH = "/api/media/v1";
const MEDIA_DOCS_PATH = `${MEDIA_API_BASE_PATH}/docs`;
const MEDIA_CAPABILITIES_PATH = `${MEDIA_API_BASE_PATH}/capabilities`;
const MEDIA_GENERATE_PATH = `${MEDIA_API_BASE_PATH}/generate`;
const MEDIA_REALTIME_SESSION_PATH = `${MEDIA_API_BASE_PATH}/realtime/session`;
const MEDIA_FAL_WEBHOOK_PATH = `${MEDIA_API_BASE_PATH}/webhooks/fal`;
const MEDIA_SUBSCRIPTION_QUERY = "api.media_jobs.getByJobId";

const MEDIA_RATE_LIMIT = 20;
const MEDIA_RATE_WINDOW_MS = 5 * 60_000;
const MEDIA_DENY_BUFFER_MICRO_CENTS = dollarsToMicroCents(0.8);
const MEDIA_REALTIME_EVENT_RATE_LIMIT = 1_200;
const MEDIA_REALTIME_EVENT_WINDOW_MS = 15 * 60_000;

type FalWebhookPayload = {
  request_id?: unknown;
  gateway_request_id?: unknown;
  status?: unknown;
  payload?: unknown;
  payload_error?: unknown;
  error?: unknown;
};

type MediaRealtimeSessionRequest = {
  sessionId?: unknown;
  event?: unknown;
  endpointId?: unknown;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const parseMediaRealtimeSessionRequest = (
  value: unknown,
): {
  sessionId: string;
  event: "start" | "heartbeat" | "stop";
  endpointId?: string;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = asTrimmedString(value.sessionId);
  const endpointId = asTrimmedString(value.endpointId);
  const event =
    value.event === "start" || value.event === "heartbeat" || value.event === "stop"
      ? value.event
      : null;
  if (!sessionId || !event) {
    return null;
  }
  return {
    sessionId,
    event,
    ...(endpointId ? { endpointId } : {}),
  };
};

const hasAspectRatioSupport = (capability: MediaCapability): boolean =>
  capability.supportsAspectRatio === true;

const applyCapabilityDefaults = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
}): Record<string, unknown> => {
  const normalized = { ...args.input };
  if (args.capability.id === "icon") {
    normalized.image_size = { width: 512, height: 512 };
  }
  return normalized;
};

const isHttpUrl = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const isDataUri = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  /^data:[^;,\s]+;base64,[A-Za-z0-9+/=\s]+$/i.test(value.trim());

const isMediaSourceReference = (value: unknown): value is string =>
  isHttpUrl(value) || isDataUri(value);

const isMimeType = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.trim());

const normalizeBase64Payload = (value: string): string =>
  value.replace(/^data:[^;,\s]+;base64,/i, "").replace(/\s+/g, "");

const isValidBase64Payload = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = normalizeBase64Payload(value);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return false;
  }
  try {
    atob(normalized);
    return true;
  } catch {
    return false;
  }
};

const toMediaSourceDataUri = (args: { mimeType: string; base64: string }): string =>
  `data:${args.mimeType};base64,${normalizeBase64Payload(args.base64)}`;

const SOURCE_SLOT_ALIASES: Record<string, string> = {
  image: "image_url",
  video: "video_url",
  audio: "audio_url",
  reference_image: "reference_image_url",
  reference_video: "reference_video_url",
  mask_image: "mask_image_url",
};

const normalizeSourceReference = (
  value:
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      },
): string =>
  typeof value === "string"
    ? value.trim()
    : toMediaSourceDataUri({ mimeType: value.mimeType, base64: value.base64 });

const toMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "IN_QUEUE":
    case "PENDING":
    case "QUEUED":
      return "queued";
    case "COMPLETED":
    case "OK":
      return "succeeded";
    case "FAILED":
    case "ERROR":
    case "PAYLOAD_ERROR":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    default:
      return "running";
  }
};

export const applyConvenienceInput = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?:
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      };
  sources?: Record<
    string,
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      }
  >;
}): Record<string, unknown> => {
  const normalized = applyCapabilityDefaults(args);
  if (args.prompt && args.capability.promptKey && normalized[args.capability.promptKey] === undefined) {
    normalized[args.capability.promptKey] = args.prompt;
  }
  if (args.aspectRatio && hasAspectRatioSupport(args.capability) && normalized.aspect_ratio === undefined) {
    normalized.aspect_ratio = args.aspectRatio;
  }
  if (args.sourceUrl && args.capability.sourceUrlKey && normalized[args.capability.sourceUrlKey] === undefined) {
    normalized[args.capability.sourceUrlKey] = args.sourceUrl;
  }
  if (args.source && args.capability.sourceUrlKey && normalized[args.capability.sourceUrlKey] === undefined) {
    normalized[args.capability.sourceUrlKey] = normalizeSourceReference(args.source);
  }
  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const slot = SOURCE_SLOT_ALIASES[key] ?? key;
      if (normalized[slot] === undefined) {
        normalized[slot] = normalizeSourceReference(value);
      }
    }
  }
  return normalized;
};

const requireCapabilityInputs = (args: {
  capability: MediaCapability;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?: {
    base64: string;
    mimeType: string;
    fileName?: string;
  } | string;
  sources?: Record<
    string,
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      }
  >;
  input: Record<string, unknown>;
}): string | null => {
  const normalized = applyConvenienceInput(args);
  const validateSource = (
    label: string,
    value:
      | string
      | {
          base64: string;
          mimeType: string;
          fileName?: string;
        },
  ): string | null => {
    if (typeof value === "string") {
      return isMediaSourceReference(value)
        ? null
        : `${label} must be a valid http(s) URL or data URI`;
    }
    if (!isMimeType(value.mimeType)) return `${label}.mimeType must be a valid MIME type`;
    if (!isValidBase64Payload(value.base64)) return `${label}.base64 must be valid base64`;
    return null;
  };
  if (args.source) {
    const error = validateSource("source", args.source);
    if (error) return error;
  }
  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const error = validateSource(`sources.${key}`, value);
      if (error) return error;
    }
  }
  if (args.aspectRatio !== undefined && !isNonEmptyString(args.aspectRatio)) {
    return "aspectRatio must be a non-empty string";
  }
  if (args.capability.promptKey && !isNonEmptyString(normalized[args.capability.promptKey])) {
    return "prompt is required for this capability";
  }
  if (args.capability.requiresSourceUrl && (!args.capability.sourceUrlKey || !isMediaSourceReference(normalized[args.capability.sourceUrlKey]))) {
    return "A valid http(s) sourceUrl or source.base64 input is required for this capability";
  }
  if (args.capability.sourceUrlKey && normalized[args.capability.sourceUrlKey] !== undefined && !isMediaSourceReference(normalized[args.capability.sourceUrlKey])) {
    return "sourceUrl must be a valid http(s) URL or data URI";
  }
  if (args.capability.id === "sound_effects") {
    const durationSeconds = normalized.duration_seconds;
    if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return "duration_seconds is required for this capability";
    }
  }
  return null;
};

const renderMediaDocs = (request: Request): string => {
  const url = new URL(request.url);
  const stellaBaseUrl = `${url.origin}/api/stella/v1`;
  const musicKeyUrl = `${url.origin}/api/music/api-key`;
  return [
    "# Stella Media SDK",
    "",
    "Stable backend-managed media API for Stella app builders.",
    "",
    "Rules:",
    "- Use capability IDs for queued backend-managed media jobs.",
    `- Flux Klein realtime stays backend-owned: track session activity through \`${MEDIA_REALTIME_SESSION_PATH}\` instead of using a direct provider websocket from the client.`,
    "- Submit with HTTP, then subscribe to the Convex job query.",
    "- Stella stores job metadata/status/output metadata in Convex, not raw media bytes.",
    "- The `icon` capability is locked to fixed square generation on the backend.",
    "",
    "HTTP endpoints:",
    `- GET ${MEDIA_DOCS_PATH}`,
    `- GET ${MEDIA_CAPABILITIES_PATH}`,
    `- POST ${MEDIA_GENERATE_PATH}`,
    `- POST ${MEDIA_REALTIME_SESSION_PATH}`,
    "",
    "Convex subscription:",
    `- \`${MEDIA_SUBSCRIPTION_QUERY}\` with \`{ jobId }\``,
    "- React: `useQuery(api.media_jobs.getByJobId, { jobId })`",
    "- Imperative: `client.onUpdate(api.media_jobs.getByJobId, { jobId }, onUpdate)`",
    "",
    "Auth:",
    "- Docs and capabilities are public.",
    "- Generation requires `Authorization: Bearer <session-token>`.",
    `- Realtime session tracking also requires auth and currently only supports \`${MEDIA_REALTIME_ENDPOINT_ID}\`.`,
    `- Heartbeats must keep arriving within ${Math.floor(MEDIA_REALTIME_HEARTBEAT_TIMEOUT_MS / 1000)} seconds or the session expires and a new sessionId is required.`,
    "- Convex subscriptions use the normal authenticated Stella client session.",
    "",
    "Request body fields:",
    "- `capability` required",
    "- `profile` optional",
    "- `prompt` optional convenience field",
    "- `aspectRatio` optional convenience field for image/video capabilities",
    "- `sourceUrl`, `source`, and `sources` for media inputs",
    "- `input` for provider-specific controls",
    "- Prefer `data:` URIs for local files",
    "",
    "Example request:",
    "```json",
    JSON.stringify(
      createMediaGenerateRequestExample({
        capability: "image_to_video",
        profile: "motion",
        prompt: "animate this product photo with a slow cinematic push-in",
        aspectRatio: "16:9",
        source: "data:image/png;base64,<base64>",
        input: { duration: 5 },
      }),
      null,
      2,
    ),
    "```",
    "",
    "Example response:",
    "```json",
    JSON.stringify(
      createMediaGenerateAcceptedResponse({
        jobId: "job_123",
        capability: "text_to_image",
        profile: "best",
        status: "queued",
        upstreamStatus: "IN_QUEUE",
        subscription: {
          query: MEDIA_SUBSCRIPTION_QUERY,
          args: { jobId: "job_123" },
        },
      }),
      null,
      2,
    ),
    "```",
    "",
    "Realtime session heartbeat request:",
    "```json",
    JSON.stringify(
      {
        sessionId: "media_rt_123",
        event: "heartbeat",
        endpointId: MEDIA_REALTIME_ENDPOINT_ID,
      },
      null,
      2,
    ),
    "```",
    "",
    "Example subscribed job snapshot:",
    "```json",
    JSON.stringify(
      createMediaJobResponse({
        jobId: "job_123",
        capability: "text_to_image",
        profile: "best",
        request: {
          prompt: "cinematic rainy Tokyo alley at night",
          aspectRatio: "9:16",
          input: { negative_prompt: "blurry" },
        },
        status: "succeeded",
        upstreamStatus: "OK",
        queuePosition: null,
        output: { images: [{ url: "https://example.com/generated-image.png" }] },
        createdAt: 1_742_000_000_000,
        updatedAt: 1_742_000_010_000,
        completedAt: 1_742_000_010_000,
      }),
      null,
      2,
    ),
    "```",
    "",
    `Other Stella-managed services: ${stellaBaseUrl}/chat/completions, ${stellaBaseUrl}/models, ${musicKeyUrl}`,
  ].join("\n");
};

export const registerMediaRoutes = (http: HttpRouter) => {
  for (const path of [MEDIA_DOCS_PATH, MEDIA_CAPABILITIES_PATH, MEDIA_GENERATE_PATH, MEDIA_REALTIME_SESSION_PATH, MEDIA_FAL_WEBHOOK_PATH]) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
    });
  }

  http.route({
    path: MEDIA_DOCS_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        withCors(new Response(renderMediaDocs(request), {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }), origin),
      )),
  });

  http.route({
    path: MEDIA_CAPABILITIES_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        jsonResponse({ data: listMediaCapabilities(), docsUrl: new URL(MEDIA_DOCS_PATH, request.url).toString() }, 200, origin),
      )),
  });

  http.route({
    path: MEDIA_REALTIME_SESSION_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const ownerId = identity?.subject ?? (isMediaPublicTestModeEnabled() ? PUBLIC_MEDIA_TEST_OWNER_ID : null);
        if (!ownerId) return errorResponse(401, "Unauthorized", origin);
        const rateLimit = await ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
          scope: "media_realtime_session",
          key: ownerId,
          limit: MEDIA_REALTIME_EVENT_RATE_LIMIT,
          windowMs: MEDIA_REALTIME_EVENT_WINDOW_MS,
          blockMs: MEDIA_REALTIME_EVENT_WINDOW_MS,
        });
        if (!rateLimit.allowed) return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);

        let requestBody: MediaRealtimeSessionRequest | null = null;
        try {
          requestBody = (await request.json()) as MediaRealtimeSessionRequest;
        } catch {
          requestBody = null;
        }
        const body = parseMediaRealtimeSessionRequest(requestBody);
        if (!body) {
          return errorResponse(400, "Invalid realtime session JSON body", origin);
        }
        const endpointId = body.endpointId ?? MEDIA_REALTIME_ENDPOINT_ID;
        if (endpointId !== MEDIA_REALTIME_ENDPOINT_ID) {
          return errorResponse(400, `Unsupported realtime endpoint. Only ${MEDIA_REALTIME_ENDPOINT_ID} is allowed.`, origin);
        }
        let preStartLimit: { allowed: boolean; message: string } | null = null;
        if (body.event === "start") {
          preStartLimit = await checkManagedUsageLimit(ctx, ownerId, {
            minimumRemainingMicroCents: MEDIA_DENY_BUFFER_MICRO_CENTS,
          });
          if (!preStartLimit.allowed) return errorResponse(429, preStartLimit.message, origin);
        }
        let activity;
        try {
          activity = await ctx.runMutation(internal.media_realtime_sessions.syncSessionActivity, {
            ownerId,
            sessionId: body.sessionId,
            event: body.event,
            endpointId,
          });
        } catch (error) {
          if (error instanceof ConvexError) {
            const code = typeof error.data?.code === "string" ? error.data.code : undefined;
            const message =
              typeof error.data?.message === "string"
                ? error.data.message
                : "Invalid realtime media session request.";
            const status =
              code === "NOT_FOUND" ? 404
                : code === "CONFLICT" ? 409
                  : 400;
            return errorResponse(status, message, origin);
          }
          throw error;
        }
        const postHeartbeatLimit =
          body.event === "stop"
            ? { allowed: true, message: "" }
            : preStartLimit ?? await checkManagedUsageLimit(ctx, ownerId, {
              minimumRemainingMicroCents: MEDIA_DENY_BUFFER_MICRO_CENTS,
            });
        if (activity.expired && body.event !== "stop") {
          return jsonResponse({
            ...activity,
            shouldStop: true,
            stopReason: `Realtime media session expired after ${Math.floor(MEDIA_REALTIME_HEARTBEAT_TIMEOUT_MS / 1000)} seconds without a heartbeat. Start a new session.`,
          }, 409, origin);
        }
        return jsonResponse({
          ...activity,
          shouldStop: !postHeartbeatLimit.allowed,
          ...(postHeartbeatLimit.allowed ? {} : { stopReason: postHeartbeatLimit.message }),
        }, 200, origin);
      })),
  });

  http.route({
    path: MEDIA_GENERATE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const ownerId = identity?.subject ?? (isMediaPublicTestModeEnabled() ? PUBLIC_MEDIA_TEST_OWNER_ID : null);
        if (!ownerId) return errorResponse(401, "Unauthorized", origin);
        const subscriptionCheck = await checkManagedUsageLimit(ctx, ownerId, {
          minimumRemainingMicroCents: MEDIA_DENY_BUFFER_MICRO_CENTS,
        });
        if (!subscriptionCheck.allowed) return errorResponse(429, subscriptionCheck.message, origin);
        const rateLimit = await ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
          scope: "media_generate",
          key: ownerId,
          limit: MEDIA_RATE_LIMIT,
          windowMs: MEDIA_RATE_WINDOW_MS,
          blockMs: MEDIA_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);

        let requestBody: unknown;
        try {
          requestBody = await request.json();
        } catch {
          requestBody = null;
        }
        const body = parseMediaGenerateRequest(requestBody);
        if (!body) return errorResponse(400, "Invalid media generation JSON body", origin);
        const resolved = resolveMediaProfile(body.capability, body.profile);
        if (!resolved) return errorResponse(400, "Unknown capability or profile. See /api/media/v1/capabilities.", origin);
        const validationError = requireCapabilityInputs({
          capability: resolved.capability,
          prompt: body.prompt,
          aspectRatio: body.aspectRatio,
          sourceUrl: body.sourceUrl,
          source: body.source,
          sources: body.sources,
          input: body.input,
        });
        if (validationError) return errorResponse(400, validationError, origin);
        if (resolved.profile.endpointId === MEDIA_REALTIME_ENDPOINT_ID) {
          return errorResponse(
            409,
            `Realtime media uses the backend session wrapper. Use ${MEDIA_REALTIME_SESSION_PATH} to start, heartbeat, and stop active realtime usage.`,
            origin,
          );
        }
        const submissionInput = applyConvenienceInput({
          capability: resolved.capability,
          input: body.input,
          prompt: body.prompt,
          aspectRatio: body.aspectRatio,
          sourceUrl: body.sourceUrl,
          source: body.source,
          sources: body.sources,
        });
        const storedRequest = summarizeMediaRequestForStorage({
          ...body,
          input: submissionInput,
        });
        const billingAdmissionIssue = getMediaBillingAdmissionIssue({
          endpointId: resolved.profile.endpointId,
          request: storedRequest,
        });
        if (billingAdmissionIssue) {
          return errorResponse(503, `Media billing is not configured for ${resolved.profile.endpointId}: ${billingAdmissionIssue}`, origin);
        }
        const apiKey = getFalApiKey();
        if (!apiKey) return errorResponse(503, "Media generation is not configured yet.", origin);

        const jobId = crypto.randomUUID();
        await ctx.runMutation(internal.media_jobs.createJob, {
          ownerId,
          jobId,
          capability: resolved.capability.id,
          profile: resolved.profile.id,
          provider: "fal",
          endpointId: resolved.profile.endpointId,
          request: storedRequest,
        });

        try {
          const submitted = await submitFalRequest({
            apiKey,
            endpointId: resolved.profile.endpointId,
            input: submissionInput,
            webhookUrl: `${new URL(MEDIA_FAL_WEBHOOK_PATH, request.url).toString()}?jobId=${encodeURIComponent(jobId)}`,
          });
          await ctx.runMutation(internal.media_jobs.markSubmitted, {
            jobId,
            providerRequestId: submitted.requestId,
            ...(submitted.gatewayRequestId ? { providerGatewayRequestId: submitted.gatewayRequestId } : {}),
            ...(submitted.responseUrl ? { providerResponseUrl: submitted.responseUrl } : {}),
            ...(submitted.statusUrl ? { providerStatusUrl: submitted.statusUrl } : {}),
            upstreamStatus: submitted.upstreamStatus,
            ...(submitted.queuePosition !== undefined ? { queuePosition: submitted.queuePosition } : {}),
          });
          return jsonResponse(createMediaGenerateAcceptedResponse({
            jobId,
            capability: resolved.capability.id,
            profile: resolved.profile.id,
            status: toMediaJobStatus(submitted.upstreamStatus),
            upstreamStatus: submitted.upstreamStatus,
            subscription: { query: MEDIA_SUBSCRIPTION_QUERY, args: { jobId } },
          }), 202, origin);
        } catch (error) {
          await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
            jobId,
            upstreamStatus: "ERROR",
            error:
              (createMediaJobError({
                value: (error as Error).message,
                fallbackMessage: "Media generation failed upstream.",
              }) ?? { message: "Media generation failed upstream." }) as never,
          });
          return errorResponse(502, `Fal request failed: ${(error as Error).message || "Unknown error"}`, origin);
        }
      })),
  });

  http.route({
    path: MEDIA_FAL_WEBHOOK_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const rawBody = await request.text();
        if (!(await verifyFalWebhookSignature(request, rawBody))) {
          return errorResponse(400, "Invalid Fal webhook signature", origin);
        }
        let parsed: unknown;
        try {
          parsed = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          parsed = null;
        }
        if (!isRecord(parsed)) return errorResponse(400, "Invalid Fal webhook payload", origin);
        const payload = parsed as FalWebhookPayload;
        const requestId = asTrimmedString(payload.request_id);
        const gatewayRequestId = asTrimmedString(payload.gateway_request_id);
        const upstreamStatus = asTrimmedString(payload.status)?.toUpperCase() ?? "ERROR";
        const jobId = new URL(request.url).searchParams.get("jobId")?.trim() || undefined;
        const dedupKey = `${requestId ?? jobId ?? "unknown"}:${await hashSha256Hex(rawBody)}`;
        const accepted = await consumeWebhookDedup(ctx, "media_fal_webhook", dedupKey);
        if (!accepted) return jsonResponse({ received: true, duplicate: true }, 200, origin);

        const webhookJob = jobId
          ? await ctx.runQuery(internal.media_jobs.getWebhookJob, { jobId })
          : null;
        let output = upstreamStatus === "OK" && payload.payload !== undefined
          ? payload.payload
          : undefined;
        const payloadError = createMediaJobError({
          value: payload.payload_error,
          fallbackMessage: upstreamStatus === "OK" ? "Fal completed the job but returned a non-JSON payload." : undefined,
        });

        if (upstreamStatus === "OK" && output === undefined && payloadError) {
          const apiKey = getFalApiKey();
          const resultUrl = webhookJob?.providerResponseUrl ??
            (requestId && webhookJob?.endpointId ? buildFalResponseUrl(webhookJob.endpointId, requestId) : undefined);
          if (apiKey && resultUrl) {
            try {
              output = await fetchFalResultPayload({ apiKey, url: resultUrl });
            } catch (error) {
              console.error("[media/webhook] Failed to fetch Fal result payload", error);
            }
          }
        }

        const finalPayloadError = output === undefined ? payloadError : undefined;
        const error = finalPayloadError ?? createMediaJobError({
          value: payload.error,
          fallbackMessage: upstreamStatus === "ERROR" ? "Media generation failed upstream." : undefined,
        });
        const normalizedUpstreamStatus = finalPayloadError ? "PAYLOAD_ERROR" : upstreamStatus;
        const billing =
          normalizedUpstreamStatus === "OK"
          && output !== undefined
          && webhookJob
            ? meterCompletedMediaJob({
              endpointId: webhookJob.endpointId,
              request: webhookJob.request,
              output,
            })
            : null;
        const meteredBilling =
          billing && !("supported" in billing) ? billing : null;
        if (billing && "supported" in billing) {
          console.error(
            `[media/webhook] Failed to meter ${webhookJob?.endpointId ?? "unknown"}: ${billing.reason}`,
          );
        }

        await ctx.scheduler.runAfter(0, internal.media_jobs.applyFalWebhook, {
          ...(jobId ? { jobId } : {}),
          ...(requestId ? { providerRequestId: requestId } : {}),
          ...(gatewayRequestId ? { providerGatewayRequestId: gatewayRequestId } : {}),
          upstreamStatus: normalizedUpstreamStatus,
          ...(upstreamStatus === "OK" &&
          output !== undefined
            ? { output: output as never }
            : {}),
          ...(meteredBilling ? { billing: meteredBilling as never } : {}),
          ...(error ? { error: error as never } : {}),
          receivedAt: Date.now(),
        });
        if (meteredBilling && webhookJob && jobId) {
          await ctx.scheduler.runAfter(0, internal.billing.recordMediaCompletedUsage, {
            ownerId: webhookJob.ownerId,
            jobId,
            ...(requestId ? { providerRequestId: requestId } : {}),
            endpointId: meteredBilling.endpointId,
            costMicroCents: meteredBilling.costMicroCents,
            billingUnit: meteredBilling.billingUnit,
            quantity: meteredBilling.quantity,
          });
        }
        return jsonResponse({ received: true }, 200, origin);
      })),
  });
};

export const describeCapabilityValidation = (capabilityId: string) => {
  const resolved = resolveMediaProfile(capabilityId);
  if (!resolved) return null;
  return {
    requiresPrompt: Boolean(resolved.capability.promptKey),
    requiresSourceUrl: Boolean(resolved.capability.requiresSourceUrl),
    acceptsBase64Source: Boolean(resolved.capability.sourceUrlKey),
    supportsAspectRatio: hasAspectRatioSupport(resolved.capability),
  };
};

export const validateCapabilityRequest = (args: {
  capabilityId: string;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?: { base64: string; mimeType: string; fileName?: string } | string;
  sources?: Record<string, string | { base64: string; mimeType: string; fileName?: string }>;
  input?: Record<string, unknown>;
}) => {
  const resolved = resolveMediaProfile(args.capabilityId);
  if (!resolved) return "Unknown capability or profile. See /api/media/v1/capabilities.";
  return requireCapabilityInputs({
    capability: resolved.capability,
    prompt: args.prompt,
    aspectRatio: args.aspectRatio,
    sourceUrl: args.sourceUrl,
    source: args.source,
    sources: args.sources,
    input: args.input ?? {},
  });
};

export {
  MEDIA_API_BASE_PATH,
  MEDIA_CAPABILITIES_PATH,
  MEDIA_DOCS_PATH,
  MEDIA_FAL_WEBHOOK_PATH,
  MEDIA_GENERATE_PATH,
  MEDIA_REALTIME_SESSION_PATH,
};




