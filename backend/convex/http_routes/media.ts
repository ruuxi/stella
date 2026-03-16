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
import {
  MEDIA_JOB_STATUS_VALUES,
  createMediaGenerateRequestExample,
  createMediaGenerateAcceptedResponse,
  createMediaJobError,
  createMediaJobResponse,
  parseMediaGenerateRequest,
  type MediaJobError,
  type MediaJobStatus,
} from "../media_contract";

const MEDIA_API_BASE_PATH = "/api/media/v1";
const MEDIA_DOCS_PATH = `${MEDIA_API_BASE_PATH}/docs`;
const MEDIA_CAPABILITIES_PATH = `${MEDIA_API_BASE_PATH}/capabilities`;
const MEDIA_GENERATE_PATH = `${MEDIA_API_BASE_PATH}/generate`;
const MEDIA_JOBS_PATH = `${MEDIA_API_BASE_PATH}/jobs`;

const MEDIA_RATE_LIMIT = 20;
const MEDIA_RATE_WINDOW_MS = 5 * 60_000;
const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

type MediaJobTokenPayload = {
  ownerId: string;
  capabilityId: string;
  profileId: string;
  endpointId: string;
  requestId: string;
  statusUrl?: string | null;
  responseUrl?: string | null;
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
  error?: unknown;
};

const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
  isNonEmptyString(value) && /^data:[^;,\s]+;base64,[A-Za-z0-9+/=\s]+$/i.test(value.trim());

const isMediaSourceReference = (value: unknown): value is string =>
  isHttpUrl(value) || isDataUri(value);

const isMimeType = (value: unknown): value is string =>
  isNonEmptyString(value) && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.trim());

const normalizeBase64Payload = (value: string): string =>
  value
    .replace(/^data:[^;,\s]+;base64,/i, "")
    .replace(/\s+/g, "");

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

const toMediaSourceDataUri = (args: {
  mimeType: string;
  base64: string;
}): string =>
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
    : toMediaSourceDataUri({
        mimeType: value.mimeType,
        base64: value.base64,
      });

const normalizeSourceSlotKey = (key: string): string =>
  SOURCE_SLOT_ALIASES[key] ?? key;

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

const applyConvenienceInput = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
  prompt?: string;
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

  if (
    args.source &&
    args.capability.sourceUrlKey &&
    normalized[args.capability.sourceUrlKey] === undefined
  ) {
    normalized[args.capability.sourceUrlKey] = normalizeSourceReference(args.source);
  }

  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const normalizedKey = normalizeSourceSlotKey(key);
      if (normalized[normalizedKey] !== undefined) {
        continue;
      }
      normalized[normalizedKey] = normalizeSourceReference(value);
    }
  }

  return normalized;
};

const requireCapabilityInputs = (args: {
  capability: MediaCapability;
  prompt?: string;
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
  webhookUrl?: string;
  input: Record<string, unknown>;
}): string | null => {
  const normalized = applyConvenienceInput(args);

  const validateSourceReference = (
    label: string,
    value:
      | string
      | {
          base64: string;
          mimeType: string;
          fileName?: string;
        },
    required = false,
  ): string | null => {
    if (typeof value === "string") {
      if (isMediaSourceReference(value)) {
        return null;
      }
      return required
        ? `${label} must be a valid http(s) URL or data URI`
        : `${label} must be a valid http(s) URL or data URI`;
    }
    if (!isMimeType(value.mimeType)) {
      return `${label}.mimeType must be a valid MIME type`;
    }
    if (!isValidBase64Payload(value.base64)) {
      return `${label}.base64 must be valid base64`;
    }
    return null;
  };

  if (args.source) {
    const error = validateSourceReference("source", args.source, true);
    if (error) {
      return error;
    }
  }

  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const error = validateSourceReference(`sources.${key}`, value);
      if (error) {
        return error;
      }
    }
  }

  if (
    args.capability.promptKey &&
    !isNonEmptyString(normalized[args.capability.promptKey])
  ) {
    return "prompt is required for this capability";
  }

  if (
    args.capability.requiresSourceUrl &&
    (!args.capability.sourceUrlKey ||
      !isMediaSourceReference(normalized[args.capability.sourceUrlKey]))
  ) {
    return "A valid http(s) sourceUrl or source.base64 input is required for this capability";
  }

  if (
    args.capability.sourceUrlKey &&
    normalized[args.capability.sourceUrlKey] !== undefined &&
    !isMediaSourceReference(normalized[args.capability.sourceUrlKey])
  ) {
    return "sourceUrl must be a valid http(s) URL or data URI";
  }

  if (args.webhookUrl && !isHttpUrl(args.webhookUrl)) {
    return "webhookUrl must be a valid http(s) URL";
  }

  return null;
};

const describeCapabilityValidation = (capabilityId: string): {
  requiresPrompt: boolean;
  requiresSourceUrl: boolean;
  acceptsBase64Source: boolean;
} | null => {
  const resolved = resolveMediaProfile(capabilityId);
  if (!resolved) {
    return null;
  }
  return {
    requiresPrompt: Boolean(resolved.capability.promptKey),
    requiresSourceUrl: Boolean(resolved.capability.requiresSourceUrl),
    acceptsBase64Source: Boolean(resolved.capability.sourceUrlKey),
  };
};

const validateCapabilityRequest = (args: {
  capabilityId: string;
  prompt?: string;
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
  webhookUrl?: string;
  input?: Record<string, unknown>;
}): string | null => {
  const resolved = resolveMediaProfile(args.capabilityId);
  if (!resolved) {
    return "Unknown capability or profile. See /api/media/v1/capabilities.";
  }
  return requireCapabilityInputs({
    capability: resolved.capability,
    prompt: args.prompt,
    sourceUrl: args.sourceUrl,
    source: args.source,
    sources: args.sources,
    webhookUrl: args.webhookUrl,
    input: args.input ?? {},
  });
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

const toMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus) {
    case "IN_QUEUE":
    case "PENDING":
    case "QUEUED":
      return "queued";
    case "COMPLETED":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    default:
      return "running";
  }
};

const getStatusLogs = (value: unknown): unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

const buildMediaJobError = (
  upstreamStatus: string,
  upstreamError: unknown,
): MediaJobError | undefined =>
  createMediaJobError({
    value: upstreamError,
    fallbackMessage:
      upstreamStatus === "FAILED" || upstreamStatus === "ERROR"
        ? "Media generation failed upstream."
        : upstreamStatus === "CANCELLED" || upstreamStatus === "CANCELED"
          ? "Media generation was canceled upstream."
          : undefined,
  });

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
    responseUrl:
      typeof data.response_url === "string" ? data.response_url.trim() : null,
    statusUrl:
      typeof data.status_url === "string" ? data.status_url.trim() : null,
    upstreamStatus: normalizeFalJobStatus(data.status),
  };
};

const fetchFalJobSnapshot = async (args: {
  apiKey: string;
  profile: MediaProfile;
  requestId: string;
  statusUrl?: string | null;
  responseUrl?: string | null;
}) => {
  const statusResponse = await fetchFalJson(
    args.statusUrl?.trim() || buildFalStatusUrl(args.profile.endpointId, args.requestId),
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
  const upstreamStatus = normalizeFalJobStatus(statusData.status);
  let result: unknown;

  if (upstreamStatus === "COMPLETED") {
    const resultResponse = await fetchFalJson(
      args.responseUrl?.trim() || buildFalResultUrl(args.profile.endpointId, args.requestId),
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
    upstreamStatus,
    status: toMediaJobStatus(upstreamStatus),
    queuePosition:
      typeof statusData.queue_position === "number"
        ? statusData.queue_position
        : null,
    logs: getStatusLogs(statusData.logs),
    output: result,
    error: buildMediaJobError(
      upstreamStatus,
      statusData.error,
    ),
  };
};

const renderGenerateAcceptedExample = (request: Request): string =>
  JSON.stringify(
    createMediaGenerateAcceptedResponse({
      jobId: "<jobId>",
      capability: "text_to_image",
      profile: "best",
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      pollUrl: buildPollUrl(request, "<jobId>"),
    }),
    null,
    2,
  );

const renderGenerateRequestExample = (): string =>
  JSON.stringify(
    createMediaGenerateRequestExample({
      capability: "image_to_video",
      profile: "motion",
      prompt: "animate this product photo with a slow cinematic push-in",
      source: "data:image/png;base64,<base64>",
      input: {
        duration: 5,
      },
    }),
    null,
    2,
  );

const renderMultiSourceRequestExample = (): string =>
  JSON.stringify(
    createMediaGenerateRequestExample({
      capability: "audio_visual_separate",
      sources: {
        video: "data:video/mp4;base64,<base64>",
        audio: "data:audio/wav;base64,<base64>",
      },
      input: {
        stem: "vocals",
      },
    }),
    null,
    2,
  );

const renderJobSnapshotExample = (): string =>
  JSON.stringify(
    createMediaJobResponse({
      jobId: "<jobId>",
      capability: "text_to_image",
      profile: "best",
      status: "succeeded",
      upstreamStatus: "COMPLETED",
      queuePosition: null,
      output: {
        images: [
          {
            url: "https://example.com/generated-image.png",
          },
        ],
      },
    }),
    null,
    2,
  );

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
    `- GET ${MEDIA_CAPABILITIES_PATH} -> JSON capability catalog`,
    `- POST ${MEDIA_GENERATE_PATH} -> submit an async media job`,
    `- GET ${MEDIA_JOBS_PATH}?jobId=<jobId> -> poll an async media job`,
    "",
    "Auth:",
    "- Docs and capabilities are public and safe to fetch with curl.",
    "- Media generation and job polling require Stella auth from the client.",
    '- Send auth as `Authorization: Bearer <session-token>` on `POST /generate` and `GET /jobs`.',
    "",
    "POST /generate body:",
    "- capability: required stable capability ID",
    "- profile: optional backend-managed variant",
    "- prompt: optional convenience prompt string",
    "- sourceUrl: optional convenience source media URL",
    "- source: optional convenience source file as either an `http(s)` URL, a `data:` URI string, or an object with `mimeType`, `base64`, and optional `fileName`",
    "- sources: optional named source files for multi-input capabilities. Each value can be an `http(s)` URL, a `data:` URI string, or an object with `mimeType` and `base64`.",
    "- input: optional provider-specific pass-through object",
    "- webhookUrl: optional Fal webhook target",
    "- For source media, the most agent-friendly format is usually a `data:` URI string like `data:image/png;base64,...`.",
    "- If you use the object form, `source.base64` should be raw base64 without the `data:` prefix. The backend converts it to the provider-specific format.",
    "- For multi-input capabilities, prefer `sources` with semantic keys like `image`, `video`, `audio`, or `reference_image`. The backend maps common keys to provider field names.",
    "- Output remains URL-first and provider-normalized in `output`. Do not assume base64 output for every capability.",
    "",
    "Example `POST /generate` request body:",
    "```json",
    renderGenerateRequestExample(),
    "```",
    "",
    "Example multi-source request body:",
    "```json",
    renderMultiSourceRequestExample(),
    "```",
    "",
    "Response behavior:",
    "- `POST /generate` is always async and returns a Stella `jobId` plus a poll URL.",
    `- \`GET /jobs\` returns normalized Stella statuses: ${MEDIA_JOB_STATUS_VALUES.map((status) => `\`${status}\``).join(", ")}.`,
    "- Successful jobs expose normalized output in `output`.",
    "- Failed or canceled jobs expose a normalized `error` object with a stable `message` and optional `code` or `details`.",
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
    '    "input": { "image_size": "portrait_16_9" }',
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
    '    "prompt": "turn this into a glossy sci-fi trailer"',
    "  }'",
    "```",
    "",
    "```bash",
    `curl -X POST "${url.origin}${MEDIA_GENERATE_PATH}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer <session-token>" \\',
    '  -d \'{',
    '    "capability": "image_to_video",',
    '    "profile": "motion",',
    '    "prompt": "animate this product photo with a slow cinematic push-in",',
    '    "source": "data:image/png;base64,<base64>"',
    "  }'",
    "```",
    "",
    "```bash",
    `curl -X POST "${url.origin}${MEDIA_GENERATE_PATH}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer <session-token>" \\',
    '  -d \'{',
    '    "capability": "audio_visual_separate",',
    '    "sources": {',
    '      "video": "data:video/mp4;base64,<base64>",',
    '      "audio": "data:audio/wav;base64,<base64>"',
    "    }",
    "  }'",
    "```",
    "",
    "```bash",
    `curl "${url.origin}${MEDIA_JOBS_PATH}?jobId=<jobId>" \\`,
    '  -H "Authorization: Bearer <session-token>"',
    "```",
    "",
    "Example `POST /generate` response:",
    "```json",
    renderGenerateAcceptedExample(request),
    "```",
    "",
    "Example `GET /jobs` response:",
    "```json",
    renderJobSnapshotExample(),
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

        let requestBody: unknown;
        try {
          requestBody = await request.json();
        } catch {
          requestBody = null;
        }

        const body = parseMediaGenerateRequest(requestBody);
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
          source: body.source,
          webhookUrl: body.webhookUrl,
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
            source: body.source,
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
            statusUrl: submitted.statusUrl,
            responseUrl: submitted.responseUrl,
          });

          return jsonResponse(
            createMediaGenerateAcceptedResponse({
              jobId,
              capability: resolved.capability.id,
              profile: resolved.profile.id,
              status: toMediaJobStatus(submitted.upstreamStatus),
              upstreamStatus: submitted.upstreamStatus,
              pollUrl: buildPollUrl(request, jobId),
            }),
            202,
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
            statusUrl: payload.statusUrl,
            responseUrl: payload.responseUrl,
          });

          return jsonResponse(
            createMediaJobResponse({
              jobId,
              capability: payload.capabilityId,
              profile: payload.profileId,
              status: snapshot.status,
              upstreamStatus: snapshot.upstreamStatus,
              queuePosition: snapshot.queuePosition,
              logs: snapshot.logs,
              output: snapshot.output,
              error: snapshot.error,
            }),
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
  describeCapabilityValidation,
  MEDIA_API_BASE_PATH,
  MEDIA_CAPABILITIES_PATH,
  MEDIA_DOCS_PATH,
  MEDIA_GENERATE_PATH,
  MEDIA_JOBS_PATH,
  validateCapabilityRequest,
};
