import os from "node:os";
import path from "node:path";

const STRUCTURAL_TAG_RE =
  /<\/?(?:tool_call|function_call|result|response|output|input|system|assistant|user)>/gi;
const FENCE_OPEN_RE = /^\s*```(?:json|xml|html|markdown)?\s*/gim;
const FENCE_CLOSE_RE = /\s*```\s*$/gim;
const CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/g;
const TOOL_ERROR_MAX_CHARS = 2_000;

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?(?:\x1b\\)|[\x20-\x2f]+[\x30-\x7e]|[\x30-\x7e])|\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x9d[\s\S]*?(?:\x07|\x9c)|[\x80-\x9f]/g;

const SECRET_PREFIX_RE =
  /\b((?:sk-(?:proj-)?|sk-ant-|gh[pousr]_|github_pat_|xox[baprs]-|hf_|r8_|npm_|pypi-|AKIA|AIza|ya29\.|syt_)[A-Za-z0-9._:=+/~-]{10,})\b/g;
const AUTH_HEADER_RE = /(Authorization:\s*Bearer\s+)(\S+)/gi;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g;
const DB_URL_RE =
  /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi;
const URL_USERINFO_RE = /\b((?:https?|wss?|ftp):\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const ENV_ASSIGN_RE =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CLIENT[_-]?SECRET|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(['"]?)([^\s'"]{8,})\2/gi;
const JSON_SECRET_RE =
  /("(?:api_?key|token|secret|password|access_token|refresh_token|auth_token|bearer|client_secret)"\s*:\s*")([^"]{8,})(")/gi;

const URL_SECRET_PARAM_NAMES = new Set([
  "access_token",
  "auth_token",
  "api_key",
  "apikey",
  "code",
  "key",
  "password",
  "secret",
  "token",
]);

const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  {
    pattern: /ignore\s+(?:previous|all|above|prior)\s+instructions/i,
    id: "prompt_injection",
  },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "system_prompt_override" },
  {
    pattern:
      /disregard\s+(?:your|all|any)\s+(?:instructions|rules|guidelines)/i,
    id: "disregard_rules",
  },
  {
    pattern:
      /act\s+as\s+(?:if|though)\s+you\s+(?:have\s+no|don't\s+have)\s+(?:restrictions|limits|rules)/i,
    id: "bypass_restrictions",
  },
  {
    pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
    id: "html_comment_injection",
  },
  {
    pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i,
    id: "hidden_div",
  },
  {
    pattern:
      /translate\s+[\s\S]*\s+into\s+[\s\S]*\s+and\s+(?:execute|run|eval)/i,
    id: "translate_execute",
  },
  {
    pattern:
      /curl\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    id: "exfil_curl",
  },
  {
    pattern: /cat\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass)/i,
    id: "read_secrets",
  },
];

const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
]);

const maskSecret = (value: string): string => {
  if (value.length < 18) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const stripAnsi = (text: string): string =>
  /[\x1b\x80-\x9f]/.test(text) ? text.replace(ANSI_RE, "") : text;

export const redactSensitiveText = (
  text: string,
  options?: { codeFile?: boolean },
): string => {
  if (!text) return text;
  let out = text.replace(SECRET_PREFIX_RE, (_m, token: string) =>
    maskSecret(token),
  );
  out = out.replace(
    AUTH_HEADER_RE,
    (_m, prefix: string, token: string) => `${prefix}${maskSecret(token)}`,
  );
  out = out.replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]");
  out = out.replace(
    DB_URL_RE,
    (_m, prefix: string, _secret: string, suffix: string) =>
      `${prefix}***${suffix}`,
  );
  out = out.replace(JWT_RE, (token) => maskSecret(token));
  out = out.replace(
    URL_USERINFO_RE,
    (_m, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
  if (!options?.codeFile) {
    out = out.replace(
      ENV_ASSIGN_RE,
      (_m, name: string, quote: string, value: string) =>
        `${name}=${quote}${maskSecret(value)}${quote}`,
    );
    out = out.replace(
      JSON_SECRET_RE,
      (_m, prefix: string, value: string, suffix: string) =>
        `${prefix}${maskSecret(value)}${suffix}`,
    );
  }
  return redactUrlSecretParams(out);
};

const redactUrlSecretParams = (text: string): string =>
  text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      let changed = false;
      for (const [key, value] of parsed.searchParams.entries()) {
        if (
          URL_SECRET_PARAM_NAMES.has(key.toLowerCase()) &&
          value.length >= 6
        ) {
          parsed.searchParams.set(key, maskSecret(value));
          changed = true;
        }
      }
      return changed ? parsed.toString() : rawUrl;
    } catch {
      return rawUrl;
    }
  });

export const containsSecretLikeToken = (text: string): boolean => {
  SECRET_PREFIX_RE.lastIndex = 0;
  JWT_RE.lastIndex = 0;
  return SECRET_PREFIX_RE.test(text) || JWT_RE.test(text);
};

export const sanitizeToolError = (message: string): string => {
  let sanitized = String(message ?? "")
    .replace(STRUCTURAL_TAG_RE, "")
    .replace(FENCE_OPEN_RE, "")
    .replace(FENCE_CLOSE_RE, "")
    .replace(CDATA_RE, "");
  sanitized = redactSensitiveText(stripAnsi(sanitized));
  if (sanitized.length > TOOL_ERROR_MAX_CHARS) {
    sanitized = `${sanitized.slice(0, TOOL_ERROR_MAX_CHARS - 3)}...`;
  }
  return `[TOOL_ERROR] ${sanitized}`;
};

export const sanitizeToolVisibleText = (
  text: string,
  options?: { codeFile?: boolean },
): string => redactSensitiveText(stripAnsi(text), options);

export const sanitizeToolResult = <T>(value: T): T => {
  if (typeof value === "string") {
    return sanitizeToolVisibleText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeToolResult(entry)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeToolResult(entry);
    }
    return out as T;
  }
  return value;
};

export const scanPromptInjectionText = (text: string): string[] => {
  const findings: string[] = [];
  for (const char of INVISIBLE_CHARS) {
    if (text.includes(char))
      findings.push(
        `invisible_unicode_u+${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
  }
  for (const { pattern, id } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) findings.push(id);
  }
  return findings;
};

export const sanitizePromptContext = (
  text: string,
  sourceLabel: string,
): string => {
  const findings = scanPromptInjectionText(text);
  if (findings.length > 0) {
    return `[BLOCKED: ${sourceLabel} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`;
  }
  return redactSensitiveText(text);
};

export const resolveHomeRelative = (candidate: string): string => {
  const expanded = candidate.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
};
