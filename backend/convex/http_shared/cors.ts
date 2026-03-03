const DEFAULT_CORS_ALLOWED_ORIGINS = [
  "http://localhost:5714",
  "https://fromyou.ai",
  "null",
];

const parseCorsOriginList = (rawValue: string | undefined): string[] =>
  (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const CORS_ALLOWED_ORIGINS = (() => {
  const configured = new Set<string>(DEFAULT_CORS_ALLOWED_ORIGINS);
  const siteUrl = process.env.SITE_URL;
  if (siteUrl) {
    configured.add(siteUrl);
  }
  const extraOrigins = parseCorsOriginList(process.env.CORS_ALLOWED_ORIGINS);
  for (const origin of extraOrigins) {
    configured.add(origin);
  }
  return configured;
})();

const isAllowedCorsOrigin = (origin: string | null) => {
  if (!origin) return true;
  if (origin.match(/^http:\/\/localhost(:\d+)?$/)) return true;
  return CORS_ALLOWED_ORIGINS.has(origin);
};

export const getCorsHeaders = (origin: string | null) => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Device-ID, X-Provider, X-Original-Path, X-Model-Id, X-Agent-Type",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isAllowedCorsOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
};

export const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const rejectDisallowedCorsOrigin = (request: Request): Response | null => {
  const origin = request.headers.get("origin");
  if (origin && !isAllowedCorsOrigin(origin)) {
    return new Response("CORS origin denied", { status: 403 });
  }
  return null;
};

export const preflightCorsResponse = (request: Request): Response =>
  new Response(null, {
    status: 204,
    headers: getCorsHeaders(request.headers.get("origin")),
  });
