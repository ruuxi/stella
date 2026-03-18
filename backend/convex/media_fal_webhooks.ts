import { base64UrlDecode, hashSha256Hex, hexToUint8Array } from "./lib/crypto_utils";
import { isRecord } from "./shared_validators";

const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const FAL_WEBHOOK_JWKS_URL = "https://rest.alpha.fal.ai/.well-known/jwks.json";
const FAL_WEBHOOK_REQUEST_ID_HEADER = "x-fal-webhook-request-id";
const FAL_WEBHOOK_USER_ID_HEADER = "x-fal-webhook-user-id";
const FAL_WEBHOOK_SIGNATURE_HEADER = "x-fal-webhook-signature";
const FAL_WEBHOOK_TIMESTAMP_HEADER = "x-fal-webhook-timestamp";
const FAL_WEBHOOK_MAX_SKEW_SECONDS = 300;
const MEDIA_PUBLIC_TEST_WEBHOOK_HEADER = "x-stella-test-webhook";

type FalSubmitResponse = {
  request_id?: unknown;
  gateway_request_id?: unknown;
  response_url?: unknown;
  status_url?: unknown;
  status?: unknown;
  queue_position?: unknown;
};

type FalWebhookJwkSet = {
  keys?: Array<{
    x?: unknown;
  }>;
};

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

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

const falHeaders = (apiKey: string): HeadersInit => ({
  Authorization: `Key ${apiKey}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

const normalizeFalQueueStatus = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toUpperCase()
    : "IN_QUEUE";

const isMediaPublicTestModeEnabled = (): boolean =>
  process.env.MEDIA_PUBLIC_TEST_MODE?.trim() === "1";

const toCryptoBuffer = (bytes: Uint8Array): ArrayBuffer =>
  Uint8Array.from(bytes).buffer;

export const getFalApiKey = (): string | null =>
  process.env.FAL_KEY?.trim() ?? null;

export const buildFalSubmissionUrl = (
  endpointId: string,
  webhookUrl: string,
): string => {
  const url = new URL(`${FAL_QUEUE_BASE_URL}/${endpointId}`);
  url.searchParams.set("fal_webhook", webhookUrl);
  return url.toString();
};

export const buildFalResponseUrl = (
  endpointId: string,
  requestId: string,
): string => `${FAL_QUEUE_BASE_URL}/${endpointId}/requests/${requestId}`;

export const submitFalRequest = async (args: {
  apiKey: string;
  endpointId: string;
  input: Record<string, unknown>;
  webhookUrl: string;
}) => {
  const upstream = await fetchFalJson(
    buildFalSubmissionUrl(args.endpointId, args.webhookUrl),
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
  const requestId = asTrimmedString(data.request_id);
  if (!requestId) {
    throw new Error("Fal submission succeeded but no request_id was returned");
  }

  return {
    requestId,
    gatewayRequestId: asTrimmedString(data.gateway_request_id),
    upstreamStatus: normalizeFalQueueStatus(data.status),
    queuePosition:
      typeof data.queue_position === "number" ? data.queue_position : undefined,
    responseUrl: asTrimmedString(data.response_url),
    statusUrl: asTrimmedString(data.status_url),
  };
};

export const fetchFalResultPayload = async (args: {
  apiKey: string;
  url: string;
}): Promise<unknown> => {
  const upstream = await fetchFalJson(args.url, {
    method: "GET",
    headers: falHeaders(args.apiKey),
  });
  if (!upstream.ok) {
    throw new Error(
      upstream.text || `Fal result lookup failed with status ${upstream.status}`,
    );
  }
  return upstream.data;
};

let cachedFalWebhookKeys:
  | {
      expiresAt: number;
      keys: CryptoKey[];
    }
  | null = null;

const loadFalWebhookKeys = async (): Promise<CryptoKey[]> => {
  const now = Date.now();
  if (cachedFalWebhookKeys && cachedFalWebhookKeys.expiresAt > now) {
    return cachedFalWebhookKeys.keys;
  }

  const response = await fetch(FAL_WEBHOOK_JWKS_URL, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Fal webhook JWK fetch failed with status ${response.status}`);
  }

  const data = (await response.json()) as FalWebhookJwkSet;
  const importedKeys = await Promise.all(
    (data.keys ?? [])
      .map((key) => asTrimmedString(key.x))
      .filter((value): value is string => Boolean(value))
      .map(async (publicKey) =>
        await crypto.subtle.importKey(
          "raw",
          toCryptoBuffer(base64UrlDecode(publicKey)),
          { name: "Ed25519" },
          false,
          ["verify"],
        ),
      ),
  );

  if (importedKeys.length === 0) {
    throw new Error("Fal webhook JWK set did not include any usable keys");
  }

  cachedFalWebhookKeys = {
    expiresAt: now + 24 * 60 * 60 * 1000,
    keys: importedKeys,
  };
  return importedKeys;
};

export const verifyFalWebhookSignature = async (
  request: Request,
  rawBody: string,
): Promise<boolean> => {
  if (
    isMediaPublicTestModeEnabled() &&
    request.headers.get(MEDIA_PUBLIC_TEST_WEBHOOK_HEADER) === "1"
  ) {
    return true;
  }

  const requestId = request.headers.get(FAL_WEBHOOK_REQUEST_ID_HEADER)?.trim();
  const userId = request.headers.get(FAL_WEBHOOK_USER_ID_HEADER)?.trim();
  const timestamp = request.headers.get(FAL_WEBHOOK_TIMESTAMP_HEADER)?.trim();
  const signatureHex = request.headers.get(FAL_WEBHOOK_SIGNATURE_HEADER)?.trim();
  if (!requestId || !userId || !timestamp || !signatureHex) {
    return false;
  }

  const timestampInt = Number.parseInt(timestamp, 10);
  const currentTime = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestampInt) ||
    Math.abs(currentTime - timestampInt) > FAL_WEBHOOK_MAX_SKEW_SECONDS
  ) {
    return false;
  }

  const bodyHash = await hashSha256Hex(rawBody);
  const message = new TextEncoder().encode(
    `${requestId}\n${userId}\n${timestamp}\n${bodyHash}`,
  );
  const signature = hexToUint8Array(signatureHex);
  const keys = await loadFalWebhookKeys();

  for (const key of keys) {
    try {
      const valid = await crypto.subtle.verify(
        "Ed25519",
        key,
        toCryptoBuffer(signature),
        message,
      );
      if (valid) {
        return true;
      }
    } catch {
      // Try the next key.
    }
  }

  return false;
};
