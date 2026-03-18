import type { Value } from "convex/values";

type RedactionOptions = {
  redactFreeformStrings?: boolean;
  maxDepth?: number;
};

export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|client[-_]?secret|session|csrf|x[-_]api[-_]key)/i;

const URL_SECRET_RE =
  /([?&](?:api[-_]?key|token|access_token|refresh_token|session|secret|password)=)([^&#\s]+)/gi;

const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const BASIC_RE = /\b(Basic)\s+[A-Za-z0-9+/=]+\b/gi;
const COOKIE_INLINE_RE = /\b(cookie|set-cookie)\s*:\s*([^\n\r;]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const redactString = (input: string): string =>
  input
    .replace(URL_SECRET_RE, `$1${REDACTED_VALUE}`)
    .replace(BEARER_RE, `$1 ${REDACTED_VALUE}`)
    .replace(BASIC_RE, `$1 ${REDACTED_VALUE}`)
    .replace(COOKIE_INLINE_RE, `$1: ${REDACTED_VALUE}`)
    .replace(JWT_RE, REDACTED_VALUE);

const sanitizeInner = (
  value: unknown,
  options: Required<RedactionOptions>,
  depth: number,
  seen: WeakSet<object>,
): Value => {
  if (depth > options.maxDepth) {
    return "[TRUNCATED]";
  }

  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return options.redactFreeformStrings ? redactString(value) : value;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (typeof value !== "object") {
    return options.redactFreeformStrings ? redactString(String(value)) : String(value);
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeInner(entry, options, depth + 1, seen));
  }

  if (!isPlainObject(value)) {
    return options.redactFreeformStrings ? redactString(String(value)) : String(value);
  }

  const output: Record<string, Value | undefined> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      output[key] = REDACTED_VALUE;
      continue;
    }
    output[key] = sanitizeInner(entry, options, depth + 1, seen);
  }
  return output;
};

export const sanitizeSensitiveData = (
  value: unknown,
  options: RedactionOptions = {},
): Value => {
  const normalized: Required<RedactionOptions> = {
    redactFreeformStrings: options.redactFreeformStrings ?? true,
    maxDepth: options.maxDepth ?? 10,
  };
  return sanitizeInner(value, normalized, 0, new WeakSet<object>());
};

export const sanitizeForLogs = (value: unknown): Value =>
  sanitizeSensitiveData(value, { redactFreeformStrings: true });
