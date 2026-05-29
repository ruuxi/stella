/**
 * Privacy scrubbing for diagnostic logs.
 *
 * Diagnostic logs are metadata-only by design — callers pass event names,
 * pids, counts, and durations, never prompts, message bodies, or file
 * contents. This module is the defense-in-depth layer: every string that
 * reaches disk (field values, error messages, stack traces) is run through
 * `scrubText` so that secrets or personal data that accidentally end up in
 * an error message are redacted before they're written.
 *
 * The patterns intentionally err toward over-redaction. Logs are for
 * "did the worker start / why did it crash", not for reconstructing data.
 */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// `sk-...`, `Bearer xxx`, `token=xxx`, `api_key: xxx`, JWT-ish triplets.
const BEARER = /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEYED_SECRET =
  /\b(?:api[_-]?key|secret|password|passwd|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?token|cookie)\b\s*[:=]\s*["']?[^\s"',}]{6,}/gi;
const SK_KEY = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// Long opaque blobs (base64 / hex) that are almost certainly data or keys,
// never something we want in a diagnostic log.
const LONG_BLOB = /\b[A-Za-z0-9+/]{60,}={0,2}\b/g;
const LONG_HEX = /\b[0-9a-f]{48,}\b/gi;
// E.164-ish phone numbers (Stella never stores raw numbers; redact if seen).
const PHONE = /(?<!\d)\+?\d[\d\s().-]{8,}\d(?!\d)/g;

export const scrubText = (input: string): string => {
  if (!input) return input;
  return input
    .replace(JWT, "<redacted-jwt>")
    .replace(BEARER, "<redacted-token>")
    .replace(KEYED_SECRET, (match) => {
      const key = match.split(/[:=]/, 1)[0]?.trim() ?? "secret";
      return `${key}=<redacted>`;
    })
    .replace(SK_KEY, "<redacted-key>")
    .replace(EMAIL, "<email>")
    .replace(PHONE, "<phone>")
    .replace(LONG_BLOB, "<redacted>")
    .replace(LONG_HEX, "<redacted>");
};

const MAX_VALUE_LENGTH = 512;

/**
 * Coerce an arbitrary field value into a short, scrubbed, single-line
 * string suitable for a `key=value` log entry. Objects are shallow-summarized
 * (we never serialize deep structures that might carry content).
 */
export const scrubFieldValue = (value: unknown): string => {
  if (value == null) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  } else if (value instanceof Error) {
    text = value.message;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_VALUE_LENGTH) {
    text = `${text.slice(0, MAX_VALUE_LENGTH)}…(${text.length})`;
  }
  return scrubText(text);
};
