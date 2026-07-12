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
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// Bare AWS access key IDs (AKIA/ASIA prefix + 16 base32 chars).
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
// Labeled-prose AWS secret access keys, e.g. `AWS Secret Access Key: <40 chars>`.
const AWS_SECRET_LABEL_RE =
  /\b(aws\s+secret(?:\s+access)?\s+key\s*[:=]?\s*['"]?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi;
// 40-char base64 AWS secret access keys reached through an aws/secret context
// (e.g. `"aws_secret_access_key": "…"`, `aws secret=…`).
const AWS_SECRET_KEY_RE =
  /\b((?:aws|secret)[A-Za-z0-9_]*['"\s:=-]+)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi;
// Bare provider API tokens: OpenAI `sk-…`, `sk-proj-…`, `sk-svcacct-…`. The
// `sk-` prefix keeps this off ordinary hyphenated prose (task-, risk-, …).
const SK_TOKEN_RE = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g;
// Generic `key = value` assignments (whitespace around `=` allowed). Only redact
// when the KEY reads as a secret, or the VALUE is quoted / long+high-entropy —
// plain short identifiers and numbers (count=0, retries=3) stay readable.
const ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;
// Sensitive key tokens, matched only at real key-token boundaries (see
// splitKeyTokens) so `api_key`/`FOO_TOKEN`/`authToken`/bare `auth` match while
// `author`/`keyboard`/`monkey`/`donkey` do not.
const SECRET_KEY_TOKENS = new Set([
  "token",
  "secret",
  "key",
  "password",
  "passwd",
  "pwd",
  "auth",
  "cookie",
  "bearer",
  "credential",
]);
// Established FUSED (no-delimiter) sensitive key names that splitKeyTokens
// cannot break apart. Matched against the normalized key by EXACT equality
// only (see keyLooksSensitive), so `author`/`keyboard`/`monkey`/`donkey`/
// `turnkey`/`passwordless`/`accessKeyboard`/`clientSecretary` still survive.
const FUSED_SECRET_KEYS = [
  "apikey",
  "apisecret",
  "apitoken",
  "authtoken",
  "authorization",
  "accesskey",
  "accesstoken",
  "secretkey",
  "secrettoken",
  "clientsecret",
  "clientkey",
  "privatekey",
  "sessiontoken",
  "bearertoken",
  "password",
  "passwd",
  "passphrase",
];
// High-entropy value: a single opaque token (no path/URL punctuation) that is
// long and mixes letters with digits. Excludes `/` and `.` so filesystem paths
// and version strings are not mistaken for secrets.
const HIGH_ENTROPY_VALUE_RE = /^[A-Za-z0-9+_=-]{24,}$/;
const SECRET_FLAG_RE =
  /(\s--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

// Break a key into its constituent word tokens across `_`/`-` delimiters and
// camelCase / ACRONYMWord boundaries.
const splitKeyTokens = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);

const keyLooksSensitive = (key: string): boolean => {
  if (
    splitKeyTokens(key).some((token) =>
      SECRET_KEY_TOKENS.has(token.toLowerCase()),
    )
  ) {
    return true;
  }
  // Fused keys are matched by EXACT equality on the normalized key only, never
  // by prefix/suffix — otherwise benign keys that merely start or end with a
  // fused name (passwordless, accessKeyboard, clientSecretary, turnkey) would be
  // over-redacted.
  //
  // Documented residual: a fused sensitive name embedded in the MIDDLE of an
  // unrecognized key (e.g. `openaiapikeyprod=`, `myauthtokenprod=`) is not
  // matched here. This is an accepted heuristic limitation: a real secret value
  // is long/high-entropy or an sk-/AWS/JWT/private-key form and is redacted by
  // the value-based patterns regardless of key name; only a short,
  // non-secret-looking value under such an unusual key slips, which is not a
  // real secret. We deliberately do NOT chase it with more key-name patterns.
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return FUSED_SECRET_KEYS.includes(normalized);
};

const assignmentValueIsSensitive = (rawValue: string): boolean => {
  const quoted =
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"));
  if (quoted) return true;
  if (!HIGH_ENTROPY_VALUE_RE.test(rawValue)) return false;
  return /[A-Za-z]/.test(rawValue) && /[0-9]/.test(rawValue);
};

const redactAssignment = (
  match: string,
  key: string,
  rawValue: string,
): string =>
  keyLooksSensitive(key) || assignmentValueIsSensitive(rawValue)
    ? `${key}=[REDACTED]`
    : match;

export const redactSensitiveText = (input: string): string =>
  input
    .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
    .replace(URL_SECRET_RE, "$1[REDACTED]")
    .replace(AUTH_HEADER_RE, "$1: [REDACTED]")
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(BASIC_RE, "$1 [REDACTED]")
    .replace(COOKIE_INLINE_RE, "$1: [REDACTED]")
    .replace(JWT_RE, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_RE, "[REDACTED]")
    .replace(AWS_SECRET_LABEL_RE, "$1[REDACTED]")
    .replace(AWS_SECRET_KEY_RE, "$1[REDACTED]")
    .replace(SK_TOKEN_RE, "[REDACTED]")
    .replace(ASSIGNMENT_RE, redactAssignment)
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
      ...(value.cause !== undefined
        ? { cause: sanitizeSensitiveData(value.cause, depth + 1, seen) }
        : {}),
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
