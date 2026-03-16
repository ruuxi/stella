import type { MediaJobTicketPayload } from "./media_sdk_types";

const encoder = new TextEncoder();

const toBase64Url = (value: Uint8Array | string): string => {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
};

const toCryptoBuffer = (value: Uint8Array): ArrayBuffer =>
  Uint8Array.from(value).buffer;

const getTicketSecret = (): string => {
  const secret =
    process.env.MEDIA_SDK_SIGNING_SECRET?.trim() ||
    process.env.FAL_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim();
  if (!secret) {
    throw new Error(
      "Missing MEDIA_SDK_SIGNING_SECRET (or FAL_KEY / AI_GATEWAY_API_KEY fallback) for media SDK job tickets",
    );
  }
  return secret;
};

const importSigningKey = async () =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(getTicketSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const signValue = async (value: string): Promise<string> => {
  const key = await importSigningKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return toBase64Url(new Uint8Array(signature));
};

export const createMediaJobTicket = async (
  payload: MediaJobTicketPayload,
): Promise<string> => {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = await signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
};

export const parseMediaJobTicket = async (
  value: string,
): Promise<MediaJobTicketPayload | null> => {
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const key = await importSigningKey();
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    toCryptoBuffer(fromBase64Url(signature)),
    encoder.encode(encodedPayload),
  );
  if (!verified) {
    return null;
  }

  try {
    const decoded = new TextDecoder().decode(fromBase64Url(encodedPayload));
    const payload = JSON.parse(decoded) as MediaJobTicketPayload;
    if (
      typeof payload.ownerId !== "string" ||
      typeof payload.serviceId !== "string" ||
      payload.transport !== "fal_queue" ||
      typeof payload.requestId !== "string" ||
      typeof payload.endpointId !== "string" ||
      typeof payload.issuedAt !== "number"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};
