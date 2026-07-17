// STELLA-GUARD: xai-oauth-flow
// This module handles xAI device authorization and refresh tokens. Do not log
// token responses, expose credentials, or weaken verification URL validation.

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "./types.js";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3_600;

type JsonObject = Record<string, unknown>;

type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresInSeconds: number;
};

const requiredString = (body: JsonObject, field: string): string => {
  const value = body[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
};

const positiveNumber = (
  body: JsonObject,
  field: string,
  fallback?: number,
): number => {
  const value = body[field];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Invalid xAI OAuth response field: ${field}`);
};

const validateVerificationUri = (raw: string): string => {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Untrusted xAI verification URL");
  }
  return url.href;
};

const postForm = async (
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: JsonObject }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    signal,
  });
  let body: JsonObject;
  try {
    const parsed = (await response.json()) as unknown;
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonObject)
        : {};
  } catch {
    throw new Error(
      `xAI OAuth returned invalid JSON (HTTP ${response.status})`,
    );
  }
  return { ok: response.ok, status: response.status, body };
};

const responseError = (
  action: string,
  response: { status: number; body: JsonObject },
): Error => {
  const code =
    typeof response.body.error === "string" ? response.body.error : "";
  const description =
    typeof response.body.error_description === "string"
      ? response.body.error_description
      : "";
  const detail = [code, description].filter(Boolean).join(": ");
  return new Error(
    `xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
  );
};

const credentialsFromResponse = (
  body: JsonObject,
  previousRefresh?: string,
): OAuthCredentials => ({
  access: requiredString(body, "access_token"),
  refresh:
    body.refresh_token === undefined && previousRefresh
      ? previousRefresh
      : requiredString(body, "refresh_token"),
  expires:
    Date.now() +
    positiveNumber(body, "expires_in", DEFAULT_TOKEN_LIFETIME_SECONDS) * 1_000 -
    REFRESH_SKEW_MS,
});

const requestDeviceCode = async (signal?: AbortSignal): Promise<DeviceCode> => {
  const response = await postForm(
    XAI_DEVICE_CODE_URL,
    { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "stella" },
    signal,
  );
  if (!response.ok) throw responseError("device authorization", response);
  const verificationUriComplete =
    typeof response.body.verification_uri_complete === "string"
      ? validateVerificationUri(response.body.verification_uri_complete)
      : undefined;
  return {
    deviceCode: requiredString(response.body, "device_code"),
    userCode: requiredString(response.body, "user_code"),
    verificationUri: validateVerificationUri(
      requiredString(response.body, "verification_uri"),
    ),
    verificationUriComplete,
    intervalSeconds: positiveNumber(response.body, "interval", 5),
    expiresInSeconds: positiveNumber(response.body, "expires_in"),
  };
};

const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login canceled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Login canceled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const pollForTokens = async (
  device: DeviceCode,
  signal?: AbortSignal,
): Promise<OAuthCredentials> => {
  const deadline = Date.now() + device.expiresInSeconds * 1_000;
  let intervalSeconds = device.intervalSeconds;
  while (Date.now() < deadline) {
    await wait(intervalSeconds * 1_000, signal);
    const response = await postForm(
      XAI_TOKEN_URL,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_CLIENT_ID,
        device_code: device.deviceCode,
      },
      signal,
    );
    if (response.ok) return credentialsFromResponse(response.body);
    const code = response.body.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalSeconds = positiveNumber(
        response.body,
        "interval",
        intervalSeconds + 5,
      );
      continue;
    }
    if (code === "access_denied" || code === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (code === "expired_token") break;
    throw responseError("device token polling", response);
  }
  throw new Error("xAI device code expired");
};

const loginXai = async (
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> => {
  const device = await requestDeviceCode(callbacks.signal);
  callbacks.onAuth({
    url: device.verificationUriComplete ?? device.verificationUri,
    instructions: device.verificationUriComplete
      ? undefined
      : `Confirm code ${device.userCode}`,
  });
  callbacks.onProgress?.("Waiting for xAI authorization…");
  return pollForTokens(device, callbacks.signal);
};

const refreshXai = async (
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> => {
  const response = await postForm(XAI_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: XAI_CLIENT_ID,
    refresh_token: credentials.refresh,
  });
  if (!response.ok) throw responseError("token refresh", response);
  return credentialsFromResponse(response.body, credentials.refresh);
};

export const xaiOAuthProvider: OAuthProviderInterface = {
  id: "xai",
  name: "xAI (Grok/X subscription)",
  login: loginXai,
  refreshToken: refreshXai,
  getApiKey: (credentials) => credentials.access,
};
