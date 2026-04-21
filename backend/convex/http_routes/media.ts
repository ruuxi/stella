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
  createMediaGenerateAcceptedResponse,
  createMediaJobError,
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

const MEDIA_API_BASE_PATH = "/api/media/v1";
const MEDIA_CAPABILITIES_PATH = `${MEDIA_API_BASE_PATH}/capabilities`;
const MEDIA_GENERATE_PATH = `${MEDIA_API_BASE_PATH}/generate`;
const MEDIA_FAL_WEBHOOK_PATH = `${MEDIA_API_BASE_PATH}/webhooks/fal`;
const MEDIA_SUBSCRIPTION_QUERY = "api.media_jobs.getByJobId";

/**
 * Public agent-facing docs are served from the marketing site, not from the
 * backend. The backend just points callers at the right URL.
 *
 * Pages live at /docs/media (overview) and /docs/media/{images,video,audio,3d}.
 * See `stella-website/src/lib/media-docs.ts` for the source content.
 */
const MEDIA_DOCS_URL = "https://stella.sh/docs/media";

const MEDIA_RATE_LIMIT = 20;
const MEDIA_RATE_WINDOW_MS = 5 * 60_000;
const MEDIA_DENY_BUFFER_MICRO_CENTS = dollarsToMicroCents(0.8);

const MEDIA_AUTH_REQUIRED_MESSAGE =
  "Sign in to Stella to use media generation.";
const MEDIA_AUTH_REQUIRED_ACTION =
  "Ask the user to open the Stella desktop app and finish signing in (Settings → Account, or the welcome screen on first launch). Once they're signed in, retry the same request — no payload changes needed.";

/**
 * Structured 401 used by the auth-gated media endpoint. Designed for *agent*
 * consumers as much as for browsers:
 *
 * - `code` is a stable machine-readable identifier (`auth_required`) so the
 *   caller can branch without parsing the human message.
 * - `action` is a short instruction the agent can surface to the user
 *   verbatim. Without this, the previous bare "Unauthorized" body left the
 *   agent guessing what to do (and silently dead-ending the user).
 * - `docsUrl` lets the agent recover by re-reading the contract.
 * - The standard `WWW-Authenticate` header is set so non-agent HTTP clients
 *   handle the response correctly.
 */
const mediaUnauthorizedResponse = (
  _request: Request,
  origin: string | null,
): Response => {
  const response = jsonResponse(
    {
      error: MEDIA_AUTH_REQUIRED_MESSAGE,
      code: "auth_required",
      action: MEDIA_AUTH_REQUIRED_ACTION,
      docsUrl: MEDIA_DOCS_URL,
    },
    401,
    origin,
  );
  response.headers.set(
    "WWW-Authenticate",
    'Bearer realm="stella-media", error="invalid_token", error_description="Sign in to Stella to use media generation."',
  );
  return response;
};

type FalWebhookPayload = {
  request_id?: unknown;
  gateway_request_id?: unknown;
  status?: unknown;
  payload?: unknown;
  payload_error?: unknown;
  error?: unknown;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const hasAspectRatioSupport = (capability: MediaCapability): boolean =>
  capability.supportsAspectRatio === true;

/**
 * Maps a Stella-style aspect ratio (e.g. "16:9") to a {width, height} pair
 * sized to satisfy the GPT Image 2 input constraints:
 *   - width and height are multiples of 16
 *   - max edge ≤ 3840
 *   - 655,360 ≤ width × height ≤ 8,294,400
 *   - longest edge ≤ 3× shortest edge
 *
 * Anything we don't recognize maps to undefined so the upstream default
 * (`landscape_4_3`) kicks in instead of us hard-failing the request.
 */
const GPT_IMAGE_2_ASPECT_PRESETS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "3:2": { width: 1152, height: 768 },
  "2:3": { width: 768, height: 1152 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "21:9": { width: 1344, height: 576 },
};

const isGptImage2Endpoint = (endpointId: string): boolean =>
  endpointId === "openai/gpt-image-2" || endpointId === "openai/gpt-image-2/edit";

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

/**
 * Endpoint-specific final pass after all the convenience-field merging is
 * done. This is where we translate from the gateway's neutral schema (e.g.
 * `aspect_ratio`) into whatever shape a particular upstream model expects
 * (e.g. GPT Image 2's `image_size`). Keeping this separate from
 * `applyCapabilityDefaults` means it sees the *final* merged input.
 */
const applyEndpointTransforms = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
}): Record<string, unknown> => {
  const normalized = { ...args.input };
  const targetsGptImage2 = args.capability.profiles.some((p) =>
    isGptImage2Endpoint(p.endpointId),
  );
  if (targetsGptImage2 && typeof normalized.aspect_ratio === "string") {
    if (normalized.image_size === undefined) {
      const mapped = GPT_IMAGE_2_ASPECT_PRESETS[normalized.aspect_ratio.trim()];
      if (mapped) {
        normalized.image_size = mapped;
      }
    }
    delete normalized.aspect_ratio;
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
  /^data:[^;,\s]+;base64,/i.test(value);

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
  // Only validate a small prefix — decoding multi-MB payloads crashes the runtime.
  const sample = normalized.slice(0, 256);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sample)) {
    return false;
  }
  try {
    atob(sample);
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
  const rawSourceValue = args.sourceUrl ?? (args.source ? normalizeSourceReference(args.source) : undefined);
  if (rawSourceValue && args.capability.sourceUrlKey && normalized[args.capability.sourceUrlKey] === undefined) {
    normalized[args.capability.sourceUrlKey] = args.capability.sourceUrlKey.endsWith("_urls") ? [rawSourceValue] : rawSourceValue;
  }
  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const slot = SOURCE_SLOT_ALIASES[key] ?? key;
      if (normalized[slot] === undefined) {
        normalized[slot] = normalizeSourceReference(value);
      }
    }
  }
  return applyEndpointTransforms({ capability: args.capability, input: normalized });
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
  const sourceSlotValue = args.capability.sourceUrlKey ? normalized[args.capability.sourceUrlKey] : undefined;
  const sourceSlotRef = Array.isArray(sourceSlotValue) ? sourceSlotValue[0] : sourceSlotValue;
  if (args.capability.requiresSourceUrl && (!args.capability.sourceUrlKey || !isMediaSourceReference(sourceSlotRef))) {
    return "A valid http(s) sourceUrl or source.base64 input is required for this capability";
  }
  if (args.capability.sourceUrlKey && sourceSlotRef !== undefined && !isMediaSourceReference(sourceSlotRef)) {
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

export const registerMediaRoutes = (http: HttpRouter) => {
  for (const path of [MEDIA_CAPABILITIES_PATH, MEDIA_GENERATE_PATH, MEDIA_FAL_WEBHOOK_PATH]) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
    });
  }

  http.route({
    path: MEDIA_CAPABILITIES_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        jsonResponse({ data: listMediaCapabilities(), docsUrl: MEDIA_DOCS_URL }, 200, origin),
      )),
  });

  http.route({
    path: MEDIA_GENERATE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const ownerId = identity?.tokenIdentifier ?? (isMediaPublicTestModeEnabled() ? PUBLIC_MEDIA_TEST_OWNER_ID : null);
        if (!ownerId) return mediaUnauthorizedResponse(request, origin);
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
        try {
          const body = parseMediaGenerateRequest(requestBody);
          if (!body) return errorResponse(400, "Invalid media generation JSON body", origin);
          const resolved = resolveMediaProfile(body.capability, body.profile);
          if (!resolved) return errorResponse(400, `Unknown capability or profile. See ${MEDIA_DOCS_URL}.`, origin);
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
        } catch (error) {
          console.error("[media/generate] Unhandled error:", error);
          return errorResponse(500, `Media generation error: ${(error as Error).message || "Unknown error"}`, origin);
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
  if (!resolved) return `Unknown capability or profile. See ${MEDIA_DOCS_URL}.`;
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
  MEDIA_DOCS_URL,
  MEDIA_FAL_WEBHOOK_PATH,
  MEDIA_GENERATE_PATH,
};




