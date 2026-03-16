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
import {
  listMediaCapabilities,
  resolveMediaProfile,
  type MediaCapability,
  type MediaProfile,
} from "../media_catalog";

const MEDIA_API_BASE_PATH = "/api/media/v1";
const MEDIA_DOCS_PATH = `${MEDIA_API_BASE_PATH}/docs`;
const MEDIA_SDK_JSON_PATH = `${MEDIA_API_BASE_PATH}/sdk`;
const MEDIA_SDK_MARKDOWN_PATH = `${MEDIA_API_BASE_PATH}/sdk.md`;
const MEDIA_CAPABILITIES_PATH = `${MEDIA_API_BASE_PATH}/capabilities`;
const MEDIA_GENERATE_PATH = `${MEDIA_API_BASE_PATH}/generate`;
const MEDIA_JOBS_PATH = `${MEDIA_API_BASE_PATH}/jobs`;

const MEDIA_RATE_LIMIT = 20;
const MEDIA_RATE_WINDOW_MS = 5 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

type MediaGenerateRequest = {
  capability?: unknown;
  profile?: unknown;
  prompt?: unknown;
  sourceUrl?: unknown;
  input?: unknown;
  wait?: unknown;
  timeoutMs?: unknown;
  webhookUrl?: unknown;
};

type MediaJobTokenPayload = {
  ownerId: string;
  capabilityId: string;
  profileId: string;
  endpointId: string;
  requestId: string;
};

type FalSubmitResponse = {
  request_id?: unknown;
  gateway_request_id?: unknown;
  response_url?: unknown;
  status_url?: unknown;
  cancel_url?: unknown;
  status?: unknown;
};

type FalStatusResponse = {
  status?: unknown;
  response_url?: unknown;
  status_url?: unknown;
  cancel_url?: unknown;
  logs?: unknown;
  queue_position?: unknown;
  request_id?: unknown;
};

const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampWaitTimeout = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  const rounded = Math.round(value);
  if (rounded < MIN_WAIT_TIMEOUT_MS) {
    return MIN_WAIT_TIMEOUT_MS;
  }
  if (rounded > MAX_WAIT_TIMEOUT_MS) {
    return MAX_WAIT_TIMEOUT_MS;
  }
  return rounded;
};

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
};

const encodeJsonToken = (value: unknown): string =>
  toBase64Url(encoder.encode(JSON.stringify(value)));

const decodeJsonToken = <T>(value: string): T =>
  JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as T;

const toCryptoBuffer = (value: Uint8Array): ArrayBuffer =>
  Uint8Array.from(value).buffer;

const getMediaSigningSecret = (): string | null =>
  process.env.MEDIA_JOB_TOKEN_SECRET?.trim() ??
  process.env.FAL_KEY?.trim() ??
  process.env.AI_GATEWAY_API_KEY?.trim() ??
  null;

const getFalApiKey = (): string | null =>
  process.env.FAL_KEY?.trim() ?? null;

const importHmacKey = async (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const signMediaJobToken = async (
  payload: MediaJobTokenPayload,
): Promise<string> => {
  const secret = getMediaSigningSecret();
  if (!secret) {
    throw new Error("Media job signing secret is not configured");
  }
  const payloadToken = encodeJsonToken(payload);
  const key = await importHmacKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payloadToken)),
  );
  return `${payloadToken}.${toBase64Url(signature)}`;
};

const verifyMediaJobToken = async (
  token: string,
): Promise<MediaJobTokenPayload | null> => {
  const secret = getMediaSigningSecret();
  if (!secret) {
    return null;
  }
  const [payloadToken, signatureToken] = token.split(".");
  if (!payloadToken || !signatureToken) {
    return null;
  }

  try {
    const key = await importHmacKey(secret);
    const signatureBytes = fromBase64Url(signatureToken);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      toCryptoBuffer(signatureBytes),
      encoder.encode(payloadToken),
    );
    if (!valid) {
      return null;
    }
    return decodeJsonToken<MediaJobTokenPayload>(payloadToken);
  } catch {
    return null;
  }
};

const createTextResponse = (
  body: string,
  status: number,
  origin: string | null,
  contentType: string,
): Response =>
  withCors(
    new Response(body, {
      status,
      headers: {
        "Content-Type": contentType,
      },
    }),
    origin,
  );

const parseGenerateRequest = async (
  request: Request,
): Promise<{
  capability: string;
  profile?: string;
  prompt?: string;
  sourceUrl?: string;
  input: Record<string, unknown>;
  wait: boolean;
  timeoutMs: number;
  webhookUrl?: string;
} | null> => {
  let body: MediaGenerateRequest;
  try {
    body = (await request.json()) as MediaGenerateRequest;
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  const capability =
    typeof body.capability === "string" ? body.capability.trim() : "";
  if (!capability) {
    return null;
  }

  const profile =
    typeof body.profile === "string" && body.profile.trim().length > 0
      ? body.profile.trim().toLowerCase()
      : undefined;
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim().length > 0
      ? body.prompt.trim()
      : undefined;
  const sourceUrl =
    typeof body.sourceUrl === "string" && body.sourceUrl.trim().length > 0
      ? body.sourceUrl.trim()
      : undefined;
  const webhookUrl =
    typeof body.webhookUrl === "string" && body.webhookUrl.trim().length > 0
      ? body.webhookUrl.trim()
      : undefined;

  return {
    capability,
    profile,
    prompt,
    sourceUrl,
    input: isRecord(body.input) ? { ...body.input } : {},
    wait: body.wait === true,
    timeoutMs: clampWaitTimeout(body.timeoutMs),
    webhookUrl,
  };
};

const applyConvenienceInput = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
  prompt?: string;
  sourceUrl?: string;
}): Record<string, unknown> => {
  const normalized = { ...args.input };

  if (args.prompt && args.capability.promptKey && normalized[args.capability.promptKey] === undefined) {
    normalized[args.capability.promptKey] = args.prompt;
  }

  if (
    args.sourceUrl &&
    args.capability.sourceUrlKey &&
    normalized[args.capability.sourceUrlKey] === undefined
  ) {
    normalized[args.capability.sourceUrlKey] = args.sourceUrl;
  }

  return normalized;
};

const requireCapabilityInputs = (args: {
  capability: MediaCapability;
  prompt?: string;
  sourceUrl?: string;
  input: Record<string, unknown>;
}): string | null => {
  const normalized = applyConvenienceInput(args);

  if (
    args.capability.requiresSourceUrl &&
    (!args.capability.sourceUrlKey ||
      typeof normalized[args.capability.sourceUrlKey] !== "string" ||
      String(normalized[args.capability.sourceUrlKey]).trim().length === 0)
  ) {
    return "sourceUrl is required for this capability";
  }

  return null;
};

const falHeaders = (apiKey: string): HeadersInit => ({
  Authorization: `Key ${apiKey}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

const buildFalSubmissionUrl = (
  endpointId: string,
  webhookUrl?: string,
): string => {
  const url = new URL(`${FAL_QUEUE_BASE_URL}/${endpointId}`);
  if (webhookUrl) {
    url.searchParams.set("fal_webhook", webhookUrl);
  }
  return url.toString();
};

const buildFalStatusUrl = (endpointId: string, requestId: string): string =>
  `${FAL_QUEUE_BASE_URL}/${endpointId}/requests/${requestId}/status`;

const buildFalResultUrl = (endpointId: string, requestId: string): string =>
  `${FAL_QUEUE_BASE_URL}/${endpointId}/requests/${requestId}`;

const fetchFalJson = async (
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> => {
  const response = await fetch(url, init);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
};

const normalizeFalJobStatus = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toUpperCase()
    : "UNKNOWN";

const getStatusLogs = (value: unknown): unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

const submitFalRequest = async (args: {
  apiKey: string;
  profile: MediaProfile;
  input: Record<string, unknown>;
  webhookUrl?: string;
}) => {
  const upstream = await fetchFalJson(
    buildFalSubmissionUrl(args.profile.endpointId, args.webhookUrl),
    {
      method: "POST",
      headers: falHeaders(args.apiKey),
      body: JSON.stringify(args.input),
    },
  );

  if (!upstream.ok) {
    throw new Error(
      upstream.text || `Fal submission failed with status ${upstream.status}`,
    );
  }

  const data = isRecord(upstream.data) ? (upstream.data as FalSubmitResponse) : {};
  const requestId =
    typeof data.request_id === "string" ? data.request_id.trim() : "";
  if (!requestId) {
    throw new Error("Fal submission succeeded but no request_id was returned");
  }

  return {
    requestId,
    gatewayRequestId:
      typeof data.gateway_request_id === "string"
        ? data.gateway_request_id.trim()
        : null,
    responseUrl:
      typeof data.response_url === "string" ? data.response_url.trim() : null,
    statusUrl:
      typeof data.status_url === "string" ? data.status_url.trim() : null,
    cancelUrl:
      typeof data.cancel_url === "string" ? data.cancel_url.trim() : null,
    status: normalizeFalJobStatus(data.status),
  };
};

const fetchFalJobSnapshot = async (args: {
  apiKey: string;
  profile: MediaProfile;
  requestId: string;
}) => {
  const statusResponse = await fetchFalJson(
    buildFalStatusUrl(args.profile.endpointId, args.requestId),
    {
      method: "GET",
      headers: falHeaders(args.apiKey),
    },
  );
  if (!statusResponse.ok) {
    throw new Error(
      statusResponse.text || `Fal status lookup failed with ${statusResponse.status}`,
    );
  }

  const statusData = isRecord(statusResponse.data)
    ? (statusResponse.data as FalStatusResponse)
    : {};
  const status = normalizeFalJobStatus(statusData.status);
  let result: unknown;

  if (status === "COMPLETED") {
    const resultResponse = await fetchFalJson(
      buildFalResultUrl(args.profile.endpointId, args.requestId),
      {
        method: "GET",
        headers: falHeaders(args.apiKey),
      },
    );
    if (!resultResponse.ok) {
      throw new Error(
        resultResponse.text || `Fal result lookup failed with ${resultResponse.status}`,
      );
    }
    result = resultResponse.data;
  }

  return {
    requestId:
      typeof statusData.request_id === "string" && statusData.request_id.trim().length > 0
        ? statusData.request_id.trim()
        : args.requestId,
    status,
    responseUrl:
      typeof statusData.response_url === "string"
        ? statusData.response_url.trim()
        : buildFalResultUrl(args.profile.endpointId, args.requestId),
    statusUrl:
      typeof statusData.status_url === "string"
        ? statusData.status_url.trim()
        : buildFalStatusUrl(args.profile.endpointId, args.requestId),
    cancelUrl:
      typeof statusData.cancel_url === "string"
        ? statusData.cancel_url.trim()
        : null,
    queuePosition:
      typeof statusData.queue_position === "number"
        ? statusData.queue_position
        : null,
    logs: getStatusLogs(statusData.logs),
    result,
  };
};

const waitForFalResult = async (args: {
  apiKey: string;
  profile: MediaProfile;
  requestId: string;
  timeoutMs: number;
}) => {
  const deadline = Date.now() + args.timeoutMs;

  while (Date.now() <= deadline) {
    const snapshot = await fetchFalJobSnapshot(args);
    if (
      snapshot.status === "COMPLETED" ||
      snapshot.status === "FAILED" ||
      snapshot.status === "ERROR" ||
      snapshot.status === "CANCELLED"
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return null;
};

const formatFalErrorMessage = (message: string): string =>
  message.startsWith("Fal ")
    ? message
    : `Fal request failed: ${message}`;

const renderMediaSdkDocs = (request: Request): string => {
  const url = new URL(request.url);
  const baseUrl = `${url.origin}${MEDIA_API_BASE_PATH}`;
  const stellaBaseUrl = `${url.origin}/api/stella/v1`;
  const musicKeyUrl = `${url.origin}/api/music/api-key`;
  const capabilities = listMediaCapabilities();

  const lines = [
    "# Stella Media SDK",
    "",
    "Stable backend-managed media API for agents and app builders.",
    "",
    "Rules:",
    "- Use capability IDs like `text_to_image` or `video_to_video` instead of raw provider model names.",
    "- Use `profile` only when you want a specific backend-managed variant such as `best`, `fast`, `edit`, or `realtime`.",
    "- Put provider-specific knobs in `input`. The backend resolves the real Fal model and forwards the normalized payload.",
    "",
    "Base URL:",
    `- ${baseUrl}`,
    "",
    "Endpoints:",
    `- GET ${MEDIA_DOCS_PATH} -> this markdown reference`,
    `- GET ${MEDIA_SDK_JSON_PATH} -> JSON SDK summary`,
    `- GET ${MEDIA_SDK_MARKDOWN_PATH} -> curl-friendly markdown SDK alias`,
    `- GET ${MEDIA_CAPABILITIES_PATH} -> JSON capability catalog`,
    `- POST ${MEDIA_GENERATE_PATH} -> submit a media job`,
    `- GET ${MEDIA_JOBS_PATH}?jobId=<jobId> -> poll a submitted job`,
    "",
    "POST /generate body:",
    "- capability: required stable capability ID",
    "- profile: optional backend-managed variant",
    "- prompt: optional convenience prompt string",
    "- sourceUrl: optional convenience source media URL",
    "- input: optional provider-specific pass-through object",
    "- wait: optional boolean. When true, the backend polls until completion or timeout.",
    "- timeoutMs: optional wait timeout when `wait=true`",
    "- webhookUrl: optional Fal webhook target",
    "",
    "Response behavior:",
    "- `wait=false` returns a `jobId` plus status/result URLs.",
    "- `wait=true` returns the completed job payload when available.",
    "",
    "Examples:",
    "```bash",
    `curl -X POST "${url.origin}${MEDIA_GENERATE_PATH}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer <session-token>" \\',
    '  -d \'{',
    '    "capability": "text_to_image",',
    '    "profile": "best",',
    '    "prompt": "cinematic rainy Tokyo alley at night",',
    '    "input": { "image_size": "portrait_16_9" },',
    '    "wait": true',
    "  }'",
    "```",
    "",
    "```bash",
    `curl -X POST "${url.origin}${MEDIA_GENERATE_PATH}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer <session-token>" \\',
    '  -d \'{',
    '    "capability": "video_to_video",',
    '    "profile": "reference",',
    '    "sourceUrl": "https://example.com/source.mp4",',
    '    "prompt": "turn this into a glossy sci-fi trailer",',
    '    "wait": false',
    "  }'",
    "```",
    "",
    "```bash",
    `curl "${url.origin}${MEDIA_JOBS_PATH}?jobId=<jobId>" \\`,
    '  -H "Authorization: Bearer <session-token>"',
    "```",
    "",
    "Capabilities:",
  ];

  for (const capability of capabilities) {
    lines.push("");
    lines.push(`## ${capability.id}`);
    lines.push(capability.description);
    lines.push(`- Inputs: ${capability.inputHints.join(", ")}`);
    lines.push(`- Outputs: ${capability.outputHints.join(", ")}`);
    if (capability.requiresSourceUrl) {
      lines.push("- Requires `sourceUrl` or the capability-specific source field in `input`.");
    }
    for (const profile of capability.profiles) {
      const defaultTag = profile.isDefault ? " (default)" : "";
      lines.push(
        `- profile=${profile.id}${defaultTag}: ${profile.description} -> ${profile.docsUrl}`,
      );
    }
  }

  lines.push("");
  lines.push("Other Stella-managed services:");
  lines.push(`- Text LLM: POST ${stellaBaseUrl}/chat/completions with model aliases \`stella/best\`, \`stella/fast\`, or \`stella/media\`.`);
  lines.push(`- Text LLM catalog: GET ${stellaBaseUrl}/models`);
  lines.push(`- Music (existing Lyria flow): POST ${musicKeyUrl} to get the managed Google AI key used by the current music client.`);

  return lines.join("\n");
};

const buildMediaSdkJson = (request: Request) => {
  const url = new URL(request.url);
  const baseOrigin = url.origin;
  return {
    version: "2026-03-15",
    docsUrl: `${baseOrigin}${MEDIA_DOCS_PATH}`,
    docsMarkdownUrl: `${baseOrigin}${MEDIA_SDK_MARKDOWN_PATH}`,
    capabilitiesUrl: `${baseOrigin}${MEDIA_CAPABILITIES_PATH}`,
    generateUrl: `${baseOrigin}${MEDIA_GENERATE_PATH}`,
    jobsUrl: `${baseOrigin}${MEDIA_JOBS_PATH}`,
    capabilities: listMediaCapabilities(),
    llmServices: [
      {
        id: "llm",
        endpoint: `${baseOrigin}/api/stella/v1/chat/completions`,
        models: ["stella/best", "stella/fast"],
      },
      {
        id: "media_llm",
        endpoint: `${baseOrigin}/api/stella/v1/chat/completions`,
        models: ["stella/media"],
      },
    ],
    music: {
      apiKeyUrl: `${baseOrigin}/api/music/api-key`,
    },
  };
};
const buildPollUrl = (request: Request, jobId: string): string => {
  const url = new URL(MEDIA_JOBS_PATH, request.url);
  url.searchParams.set("jobId", jobId);
  return url.toString();
};

export const registerMediaRoutes = (http: HttpRouter) => {
  http.route({
    path: MEDIA_DOCS_PATH,
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: MEDIA_DOCS_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        createTextResponse(
          renderMediaSdkDocs(request),
          200,
          origin,
          "text/markdown; charset=utf-8",
        ),
      )),
  });

  http.route({
    path: MEDIA_CAPABILITIES_PATH,
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: MEDIA_CAPABILITIES_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        jsonResponse(
          {
            data: listMediaCapabilities(),
            docsUrl: `${new URL(MEDIA_DOCS_PATH, request.url).toString()}`,
          },
          200,
          origin,
        ),
      )),
  });

  http.route({
    path: MEDIA_GENERATE_PATH,
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: MEDIA_GENERATE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "media_generate",
            key: identity.subject,
            limit: MEDIA_RATE_LIMIT,
            windowMs: MEDIA_RATE_WINDOW_MS,
            blockMs: MEDIA_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const body = await parseGenerateRequest(request);
        if (!body) {
          return errorResponse(400, "Invalid media generation JSON body", origin);
        }

        const resolved = resolveMediaProfile(body.capability, body.profile);
        if (!resolved) {
          return errorResponse(
            400,
            "Unknown capability or profile. See /api/media/v1/capabilities.",
            origin,
          );
        }

        const validationError = requireCapabilityInputs({
          capability: resolved.capability,
          prompt: body.prompt,
          sourceUrl: body.sourceUrl,
          input: body.input,
        });
        if (validationError) {
          return errorResponse(400, validationError, origin);
        }

        const apiKey = getFalApiKey();
        if (!apiKey) {
          return errorResponse(
            503,
            "Media generation is not configured yet.",
            origin,
          );
        }

        try {
          const input = applyConvenienceInput({
            capability: resolved.capability,
            input: body.input,
            prompt: body.prompt,
            sourceUrl: body.sourceUrl,
          });

          const submitted = await submitFalRequest({
            apiKey,
            profile: resolved.profile,
            input,
            webhookUrl: body.webhookUrl,
          });
          const jobId = await signMediaJobToken({
            ownerId: identity.subject,
            capabilityId: resolved.capability.id,
            profileId: resolved.profile.id,
            endpointId: resolved.profile.endpointId,
            requestId: submitted.requestId,
          });

          if (!body.wait) {
            return jsonResponse(
              {
                jobId,
                capability: resolved.capability.id,
                profile: resolved.profile.id,
                requestId: submitted.requestId,
                status: submitted.status || "IN_QUEUE",
                pollUrl: buildPollUrl(request, jobId),
                responseUrl:
                  submitted.responseUrl ??
                  buildFalResultUrl(resolved.profile.endpointId, submitted.requestId),
                statusUrl:
                  submitted.statusUrl ??
                  buildFalStatusUrl(resolved.profile.endpointId, submitted.requestId),
                cancelUrl: submitted.cancelUrl,
              },
              202,
              origin,
            );
          }

          const completed = await waitForFalResult({
            apiKey,
            profile: resolved.profile,
            requestId: submitted.requestId,
            timeoutMs: body.timeoutMs,
          });

          if (!completed) {
            return jsonResponse(
              {
                jobId,
                capability: resolved.capability.id,
                profile: resolved.profile.id,
                requestId: submitted.requestId,
                status: "TIMEOUT",
                pollUrl: buildPollUrl(request, jobId),
              },
              202,
              origin,
            );
          }

          return jsonResponse(
            {
              jobId,
              capability: resolved.capability.id,
              profile: resolved.profile.id,
              requestId: completed.requestId,
              status: completed.status,
              responseUrl: completed.responseUrl,
              statusUrl: completed.statusUrl,
              cancelUrl: completed.cancelUrl,
              queuePosition: completed.queuePosition,
              logs: completed.logs,
              result: completed.result,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[media/generate] Error:", error);
          return errorResponse(
            502,
            formatFalErrorMessage((error as Error).message || "Unknown error"),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: MEDIA_JOBS_PATH,
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: MEDIA_JOBS_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const url = new URL(request.url);
        const jobId = url.searchParams.get("jobId")?.trim();
        if (!jobId) {
          return errorResponse(400, "jobId is required", origin);
        }

        const payload = await verifyMediaJobToken(jobId);
        if (!payload) {
          return errorResponse(400, "Invalid media job token", origin);
        }
        if (payload.ownerId !== identity.subject) {
          return errorResponse(403, "This media job belongs to another user", origin);
        }

        const apiKey = getFalApiKey();
        if (!apiKey) {
          return errorResponse(
            503,
            "Media generation is not configured yet.",
            origin,
          );
        }

        const resolved = resolveMediaProfile(payload.capabilityId, payload.profileId);
        if (!resolved || resolved.profile.endpointId !== payload.endpointId) {
          return errorResponse(400, "Media job no longer matches the active catalog", origin);
        }

        try {
          const snapshot = await fetchFalJobSnapshot({
            apiKey,
            profile: resolved.profile,
            requestId: payload.requestId,
          });

          return jsonResponse(
            {
              jobId,
              capability: payload.capabilityId,
              profile: payload.profileId,
              requestId: snapshot.requestId,
              status: snapshot.status,
              responseUrl: snapshot.responseUrl,
              statusUrl: snapshot.statusUrl,
              cancelUrl: snapshot.cancelUrl,
              queuePosition: snapshot.queuePosition,
              logs: snapshot.logs,
              result: snapshot.result,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[media/jobs] Error:", error);
          return errorResponse(
            502,
            formatFalErrorMessage((error as Error).message || "Unknown error"),
            origin,
          );
        }
      }),
    ),
  });
};

export {
  MEDIA_API_BASE_PATH,
  MEDIA_CAPABILITIES_PATH,
  MEDIA_DOCS_PATH,
  MEDIA_SDK_JSON_PATH,
  MEDIA_SDK_MARKDOWN_PATH,
  MEDIA_GENERATE_PATH,
  MEDIA_JOBS_PATH,
};
