/**
 * Shared anonymous device identification helpers.
 *
 * Used by synthesis, speech-to-text, and AI proxy route modules to identify
 * unauthenticated callers via X-Device-ID header and handle missing salt errors.
 */

export const getAnonDeviceId = (request: Request): string | null => {
  const deviceId = request.headers.get("X-Device-ID");
  if (!deviceId) return null;
  const trimmed = deviceId.trim();
  if (trimmed.length === 0 || trimmed.length >= 256) return null;
  return trimmed;
};

const ANON_DEVICE_HASH_SALT_MISSING_MESSAGE = "Missing ANON_DEVICE_ID_HASH_SALT";
let didLogMissingSalt = false;

/** Check whether an error was caused by a missing ANON_DEVICE_ID_HASH_SALT env var. */
export const isAnonDeviceHashSaltMissingError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes(ANON_DEVICE_HASH_SALT_MISSING_MESSAGE);

/**
 * Log a warning about missing salt — but only once per warm instance to avoid
 * flooding logs. Returns true if a warning was logged (first time), false otherwise.
 */
export function logMissingSaltOnce(context: string): boolean {
  if (didLogMissingSalt) return false;
  didLogMissingSalt = true;
  console.warn(
    `[${context}] Missing ANON_DEVICE_ID_HASH_SALT; anonymous rate limiting is disabled until configured.`,
  );
  return true;
}
