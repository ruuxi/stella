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

const maskSecret = (value: string): string => {
  if (value.length < 18) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

export const redactMemoryText = (text: string): string =>
  redactUrlSecretParams(
    text
      .replace(SECRET_PREFIX_RE, (_m, token: string) => maskSecret(token))
      .replace(
        AUTH_HEADER_RE,
        (_m, prefix: string, token: string) => `${prefix}${maskSecret(token)}`,
      )
      .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
      .replace(
        DB_URL_RE,
        (_m, prefix: string, _secret: string, suffix: string) =>
          `${prefix}***${suffix}`,
      )
      .replace(JWT_RE, (token) => maskSecret(token))
      .replace(
        URL_USERINFO_RE,
        (_m, scheme: string, user: string) => `${scheme}${user}:***@`,
      )
      .replace(
        ENV_ASSIGN_RE,
        (_m, name: string, quote: string, value: string) =>
          `${name}=${quote}${maskSecret(value)}${quote}`,
      )
      .replace(
        JSON_SECRET_RE,
        (_m, prefix: string, value: string, suffix: string) =>
          `${prefix}${maskSecret(value)}${suffix}`,
      ),
  );

export const redactMemoryStringArray = (items: string[]): string[] =>
  items.map(redactMemoryText);
