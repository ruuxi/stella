/**
 * Shared cryptographic / encoding utilities.
 *
 * Extracted from channels/connector_delivery.ts, channels/google_chat.ts,
 * channels/teams.ts, http_routes/connectors.ts, channels/slack.ts, and
 * channels/discord.ts to eliminate duplication.
 */

export function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * The early length check is acceptable for HMAC verification where both
 * inputs are hex-encoded digests of fixed length (not attacker-controlled).
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/** Convert a Uint8Array to a lowercase hex string. */
export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Convert a hex string to a Uint8Array. */
export const hexToUint8Array = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

/** SHA-256 hash returning a lowercase hex string. */
export async function hashSha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(digest));
}
