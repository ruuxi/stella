const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|client[-_]?secret|session|csrf|x[-_]api[-_]?key)/i;
const PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const URL_SECRET_RE =
  /([?&](?:api[-_]?key|token|access_token|refresh_token|session|secret|password)=)([^&#\s]+)/gi;
const AUTH_HEADER_RE =
  /\b(authorization|proxy-authorization)\s*:\s*([^\n\r]+)/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const BASIC_RE = /\b(Basic)\s+[A-Za-z0-9+/=]+\b/gi;
const COOKIE_INLINE_RE = /\b(cookie|set-cookie)\s*:\s*([^\n\r;]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ENV_ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g;
const SECRET_FLAG_RE =
  /(\s--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

export const redactSensitiveText = (input: string): string =>
  input
    .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
    .replace(URL_SECRET_RE, "$1[REDACTED]")
    .replace(AUTH_HEADER_RE, "$1: [REDACTED]")
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(BASIC_RE, "$1 [REDACTED]")
    .replace(COOKIE_INLINE_RE, "$1: [REDACTED]")
    .replace(JWT_RE, "[REDACTED]")
    .replace(ENV_ASSIGNMENT_RE, "$1=[REDACTED]")
    .replace(SECRET_FLAG_RE, "$1 [REDACTED]");

export const sanitizeSensitiveData = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      message: redactSensitiveText(value.message),
      ...(value.stack ? { stack: redactSensitiveText(value.stack) } : {}),
    };
    for (const [key, entry] of Object.entries(
      value as unknown as Record<string, unknown>,
    )) {
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : sanitizeSensitiveData(entry, depth + 1, seen);
    }
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSensitiveData(entry, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[REDACTED]"
      : sanitizeSensitiveData(entry, depth + 1, seen);
  }
  return output;
};
