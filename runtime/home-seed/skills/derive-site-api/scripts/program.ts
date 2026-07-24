#!/usr/bin/env bun
/**
 * Reduces a recorded HAR into an API surface report.
 *
 * A few minutes of browsing produces hundreds of requests and megabytes of
 * bodies. Reading that directly is both wasteful and hopeless to reason about,
 * so the mechanical part -- dropping noise, collapsing repeats, inferring
 * shapes -- happens here, and only the summary reaches the agent.
 *
 * Usage: bun program.ts <har.json> [--out <report.md>] [--json <surface.json>]
 *        [--max-endpoints N] [--include-telemetry]
 */

import { readFileSync, writeFileSync } from "node:fs";

type HarHeader = { name: string; value: string };
type StreamFrame = {
  type: string;
  data?: string;
  eventName?: string;
  opcode?: number;
};

type HarEntry = {
  startedDateTime?: string;
  _resourceType?: string;
  _webSocketMessages?: StreamFrame[];
  _eventSourceMessages?: StreamFrame[];
  request: {
    method: string;
    url: string;
    headers?: HarHeader[];
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    statusText?: string;
    headers?: HarHeader[];
    content?: { size?: number; mimeType?: string; text?: string; encoding?: string };
  };
};

/**
 * Third-party analytics, error reporting, ads and experimentation. None of it
 * belongs in a client derived for the site itself, and it is the bulk of the
 * traffic on most pages.
 */
const TELEMETRY_HOSTS = [
  "google-analytics.com", "googletagmanager.com", "doubleclick.net",
  "googlesyndication.com", "google.com/pagead", "facebook.com/tr",
  "connect.facebook.net", "segment.io", "segment.com", "amplitude.com",
  "mixpanel.com", "sentry.io", "bugsnag.com", "datadoghq.com", "newrelic.com",
  "nr-data.net", "hotjar.com", "fullstory.com", "logrocket.com", "optimizely.com",
  "launchdarkly.com", "split.io", "branch.io", "appsflyer.com", "adjust.com",
  "braze.com", "onetrust.com", "cookielaw.org", "cloudflareinsights.com",
  "clarity.ms", "quantserve.com", "scorecardresearch.com", "criteo.com",
  "taboola.com", "outbrain.com", "snowplowanalytics.com", "heap.io",
  "intercom.io", "zendesk.com", "statsig.com", "posthog.com",
];

const TELEMETRY_PATH_HINTS = [
  "/analytics", "/telemetry", "/metrics", "/beacon", "/collect", "/track",
  "/pixel", "/log-event", "/logevent", "/errors", "/rum", "/sentry",
  "/experiment", "/heartbeat", "/ping",
];

/** Header names that carry credentials or anti-CSRF state. */
const CREDENTIAL_HEADERS = new Set([
  "authorization", "cookie", "x-csrf-token", "x-xsrf-token", "csrf-token",
  "x-auth-token", "x-api-key", "api-key", "x-access-token", "x-session-token",
  "x-session-id", "x-token", "authentication", "x-amz-security-token",
]);

/** Request headers that are transport noise rather than API contract. */
const BORING_HEADERS = new Set([
  "accept-encoding", "accept-language", "cache-control", "pragma", "connection",
  "host", "user-agent", "referer", "origin", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site", "sec-fetch-user", "sec-ch-ua", "sec-ch-ua-mobile",
  "sec-ch-ua-platform", "upgrade-insecure-requests", "dnt", "te", "priority",
  "content-length", "accept",
]);

/** Key names whose values must never be echoed into a report. */
// Separators vary (`api_key`, `api-key`, `apiKey`), so match them all rather
// than a fixed spelling -- a real recording surfaced `x-algolia-api-key`
// slipping past a pattern that only knew about `apikey` and `api_key`.
const SENSITIVE_KEY =
  /(token|secret|password|passwd|auth|session|cookie|credential|signature|api[-_]?key|access[-_]?key|ssn|cvv|card|iban|account[-_]?number|email|phone|latitude|longitude|lat|lng|address|first[-_]?name|last[-_]?name|full[-_]?name)/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const OPAQUE_ID = /^[A-Za-z0-9_-]{20,}$/;

const args = process.argv.slice(2);
const harPath = args.find((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

if (!harPath) {
  console.error("usage: bun program.ts <har.json> [--out report.md] [--json surface.json]");
  process.exit(2);
}

const maxEndpoints = Number(flag("max-endpoints") ?? 60);
const includeTelemetry = hasFlag("include-telemetry");

// --- Loading -----------------------------------------------------------------

const raw = JSON.parse(readFileSync(harPath, "utf8"));
// Accept either a bare HAR or the har_stop payload that wraps one.
const entries: HarEntry[] = raw?.log?.entries ?? raw?.data?.log?.entries ?? raw?.entries ?? [];

if (!Array.isArray(entries) || entries.length === 0) {
  console.error(`No HAR entries found in ${harPath}.`);
  process.exit(1);
}

// --- Filtering ---------------------------------------------------------------

const isTelemetry = (url: string): boolean => {
  const lower = url.toLowerCase();
  if (TELEMETRY_HOSTS.some((host) => lower.includes(host))) return true;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return TELEMETRY_PATH_HINTS.some((hint) => pathname.includes(hint));
  } catch {
    return false;
  }
};

const isStreamEntry = (entry: HarEntry): boolean =>
  entry._resourceType === "WebSocket" || entry._resourceType === "EventSource";

const looksLikeApi = (entry: HarEntry): boolean => {
  const resourceType = entry._resourceType;
  if (resourceType === "XHR" || resourceType === "Fetch") return true;
  // A socket or event stream often *is* the site's API rather than an extra.
  if (isStreamEntry(entry)) return true;
  const mime = (entry.response?.content?.mimeType ?? "").toLowerCase();
  return mime.includes("json") || mime.includes("graphql");
};

const apiEntries = entries.filter((entry) => {
  if (!entry?.request?.url) return false;
  if (!looksLikeApi(entry)) return false;
  if (!includeTelemetry && isTelemetry(entry.request.url)) return false;
  return true;
});

// --- Shape inference ---------------------------------------------------------

const scalarShape = (key: string, value: unknown): string => {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return `boolean (${value})`;
  if (type === "number") return `number (${value})`;
  if (type !== "string") return type;

  const text = value as string;
  if (SENSITIVE_KEY.test(key)) return `string <redacted, len ${text.length}>`;
  if (text.length > 60) return `string <len ${text.length}>`;
  return `string (${JSON.stringify(text)})`;
};

/**
 * Collapse a parsed JSON value into a readable type sketch. Arrays are
 * represented by their first element because sibling elements are almost
 * always homogeneous and printing them all is what makes these reports huge.
 */
const inferShape = (value: unknown, key = "", depth = 0): unknown => {
  if (depth > 7) return "…";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    // Stepping into an array is not a nesting level the reader cares about;
    // charging it against the budget truncates ordinary `data.x.items[].field`
    // responses before reaching any field names.
    const element = inferShape(value[0], key, depth);
    return value.length > 1 ? [element, `…${value.length} items total`] : [element];
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object);
    for (const childKey of keys.slice(0, 25)) {
      out[childKey] = inferShape((value as Record<string, unknown>)[childKey], childKey, depth + 1);
    }
    if (keys.length > 25) out["…"] = `${keys.length - 25} more keys`;
    return out;
  }
  return scalarShape(key, value);
};

/**
 * A recorded URL carries its query string verbatim, so printing one as an
 * example would undo the redaction applied to the parameter list.
 */
const redactUrl = (rawUrl: string): string => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(name)) url.searchParams.set(name, "<redacted>");
  }
  return url.toString();
};

/**
 * Structure-only fingerprint: keys and types, no example values. Socket
 * transcripts repeat one message shape with different payloads, so grouping on
 * the rendered shape (which carries examples) would collapse nothing.
 */
const structuralKey = (value: unknown, depth = 0): string => {
  if (depth > 6) return "…";
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${structuralKey(value[0], depth + 1)}]` : "[]";
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${key}:${structuralKey((value as Record<string, unknown>)[key], depth + 1)}`)
      .join(",")}}`;
  }
  return value === null ? "null" : typeof value;
};

const parseJson = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// --- Grouping ----------------------------------------------------------------

/** Segments whose shape marks them as identifiers regardless of context. */
const isObviousId = (segment: string): string | null => {
  if (/^\d+$/.test(segment)) return "{id}";
  if (UUID.test(segment)) return "{uuid}";
  if (LONG_HEX.test(segment)) return "{hash}";
  if (OPAQUE_ID.test(segment) && !/^[a-z-]+$/i.test(segment)) return "{id}";
  return null;
};

/**
 * Short slug-style ids like `store_881` or `order-12a` are indistinguishable
 * from real path segments by shape alone. What gives them away is that they
 * vary between otherwise-identical URLs, so identifier positions are found by
 * comparing paths of the same method, host and depth against each other.
 * Version segments (`v2`) also contain digits but do not vary, and are excluded
 * outright so a single stray recording cannot collapse them.
 */
const variableSegments = new Set<string>();
{
  const buckets = new Map<string, Map<number, Set<string>>>();
  for (const entry of apiEntries) {
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue;
    }
    const segments = url.pathname.split("/");
    const bucketKey = `${entry.request.method}|${url.host}|${segments.length}`;
    let positions = buckets.get(bucketKey);
    if (!positions) {
      positions = new Map();
      buckets.set(bucketKey, positions);
    }
    segments.forEach((segment, index) => {
      let seen = positions!.get(index);
      if (!seen) {
        seen = new Set();
        positions!.set(index, seen);
      }
      seen.add(segment);
    });
  }

  for (const [bucketKey, positions] of buckets) {
    for (const [index, values] of positions) {
      if (values.size < 2) continue;
      const allIdShaped = [...values].every(
        (value) => /\d/.test(value) && value.length >= 3 && !/^v\d+$/i.test(value),
      );
      if (allIdShaped) variableSegments.add(`${bucketKey}|${index}`);
    }
  }
}

/** Replace identifier-looking path segments so repeat calls collapse together. */
const templatePath = (method: string, host: string, pathname: string): string => {
  const segments = pathname.split("/");
  const bucketKey = `${method}|${host}|${segments.length}`;
  return segments
    .map((segment, index) => {
      if (!segment) return segment;
      const obvious = isObviousId(segment);
      if (obvious) return obvious;
      if (variableSegments.has(`${bucketKey}|${index}`)) return "{id}";
      return segment;
    })
    .join("/");
};

type Group = {
  key: string;
  method: string;
  host: string;
  path: string;
  operation?: string;
  count: number;
  statuses: Map<number, number>;
  queryParams: Map<string, string>;
  requestHeaders: Map<string, string>;
  requestShape?: unknown;
  responseShape?: unknown;
  graphqlQuery?: string;
  sampleUrl: string;
  streamKind?: string;
  frames: StreamFrame[];
};

const groups = new Map<string, Group>();

for (const entry of apiEntries) {
  let url: URL;
  try {
    url = new URL(entry.request.url);
  } catch {
    continue;
  }

  const requestBody = parseJson(entry.request.postData?.text);
  const isGraphql =
    url.pathname.includes("graphql") ||
    (entry.request.postData?.mimeType ?? "").includes("graphql");

  // GraphQL multiplexes every operation over one path, so the operation name is
  // the only thing that distinguishes calls. Group on it instead of the path.
  let operation: string | undefined;
  let graphqlQuery: string | undefined;
  if (isGraphql && requestBody && typeof requestBody === "object") {
    const body = Array.isArray(requestBody) ? requestBody[0] : requestBody;
    operation = (body as Record<string, unknown>)?.operationName as string | undefined;
    graphqlQuery = (body as Record<string, unknown>)?.query as string | undefined;
  }

  const path = templatePath(entry.request.method, url.host, url.pathname);
  const key = `${entry.request.method} ${url.host}${path}${operation ? `#${operation}` : ""}`;

  let group = groups.get(key);
  if (!group) {
    group = {
      key,
      method: entry.request.method,
      host: url.host,
      path,
      operation,
      count: 0,
      statuses: new Map(),
      queryParams: new Map(),
      requestHeaders: new Map(),
      graphqlQuery,
      sampleUrl: entry.request.url,
      streamKind: isStreamEntry(entry) ? entry._resourceType : undefined,
      frames: [],
    };
    groups.set(key, group);
  }

  const frames = entry._webSocketMessages ?? entry._eventSourceMessages ?? [];
  if (frames.length > 0) group.frames.push(...frames);

  group.count += 1;
  group.statuses.set(entry.response.status, (group.statuses.get(entry.response.status) ?? 0) + 1);

  for (const [name, value] of url.searchParams) {
    if (!group.queryParams.has(name)) {
      group.queryParams.set(name, SENSITIVE_KEY.test(name) ? "<redacted>" : value.slice(0, 60));
    }
  }

  for (const header of entry.request.headers ?? []) {
    const name = header.name.toLowerCase();
    if (name.startsWith(":") || BORING_HEADERS.has(name)) continue;
    if (!group.requestHeaders.has(name)) {
      group.requestHeaders.set(
        name,
        CREDENTIAL_HEADERS.has(name) ? "<credential>" : header.value.slice(0, 80),
      );
    }
  }

  // Keep the shape from the first successful exchange; later ones add nothing
  // and error bodies would misrepresent the contract.
  const successful = entry.response.status >= 200 && entry.response.status < 300;
  if (group.requestShape === undefined && requestBody !== undefined) {
    group.requestShape = inferShape(requestBody);
  }
  if (group.responseShape === undefined && successful) {
    const responseBody = parseJson(
      entry.response.content?.encoding === "base64" ? undefined : entry.response.content?.text,
    );
    if (responseBody !== undefined) group.responseShape = inferShape(responseBody);
  }
}

// --- Auth analysis -----------------------------------------------------------

const credentialUsage = new Map<string, number>();
for (const group of groups.values()) {
  for (const name of group.requestHeaders.keys()) {
    if (CREDENTIAL_HEADERS.has(name)) {
      credentialUsage.set(name, (credentialUsage.get(name) ?? 0) + group.count);
    }
  }
}

const usesCookieAuth = credentialUsage.has("cookie");
const explicitCredentialHeaders = [...credentialUsage.keys()].filter((name) => name !== "cookie");

const authVerdict = (): string => {
  if (explicitCredentialHeaders.length === 0 && usesCookieAuth) {
    return "Cookie-only. The browser attaches these automatically, so a derived client needs no credential handling.";
  }
  if (explicitCredentialHeaders.length > 0) {
    return `Explicit credential header(s): ${explicitCredentialHeaders.join(", ")}. These are NOT attached automatically — the client must read each value from the live page (localStorage, a bootstrap response, or a meta tag) rather than hardcoding a captured value, which would expire.`;
  }
  return "No credential headers observed. These endpoints may be public, or the session may ride entirely on cookies not visible to the recorder.";
};

// --- Reporting ---------------------------------------------------------------

const ranked = [...groups.values()].sort((a, b) => {
  const aOk = [...a.statuses.keys()].some((s) => s < 400);
  const bOk = [...b.statuses.keys()].some((s) => s < 400);
  if (aOk !== bOk) return aOk ? -1 : 1;
  const aRich = a.responseShape !== undefined ? 1 : 0;
  const bRich = b.responseShape !== undefined ? 1 : 0;
  if (aRich !== bRich) return bRich - aRich;
  return b.count - a.count;
});

const shown = ranked.slice(0, maxEndpoints);
const hostCounts = new Map<string, number>();
for (const group of groups.values()) {
  hostCounts.set(group.host, (hostCounts.get(group.host) ?? 0) + group.count);
}

const fence = (value: unknown): string => "```json\n" + JSON.stringify(value, null, 2) + "\n```";

const lines: string[] = [];
lines.push("# API surface");
lines.push("");
lines.push(
  `${entries.length} requests recorded → ${apiEntries.length} API calls → ${groups.size} distinct endpoints.`,
);
const withBodies = apiEntries.filter((e) => typeof e.response.content?.text === "string").length;
lines.push(`Response bodies captured for ${withBodies} of ${apiEntries.length} API calls.`);
if (withBodies === 0) {
  lines.push("");
  lines.push(
    "> No response bodies were captured. Response shapes below will be empty. Re-record and confirm `har_start` ran before the traffic, since bodies can only be read while the recording is open.",
  );
}
lines.push("");
lines.push("## Hosts");
lines.push("");
for (const [host, count] of [...hostCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`- \`${host}\` — ${count} calls`);
}
lines.push("");
lines.push("## Authentication");
lines.push("");
lines.push(authVerdict());
if (credentialUsage.size > 0) {
  lines.push("");
  for (const [name, count] of credentialUsage) {
    lines.push(`- \`${name}\` on ${count} calls`);
  }
}
lines.push("");
lines.push(`## Endpoints (${shown.length} of ${groups.size})`);

for (const group of shown) {
  lines.push("");
  lines.push(`### ${group.method} ${group.host}${group.path}`);
  if (group.operation) lines.push(`GraphQL operation: \`${group.operation}\``);
  const statuses = [...group.statuses.entries()].map(([s, c]) => `${s}×${c}`).join(", ");
  lines.push(`Calls: ${group.count} · Status: ${statuses}`);
  // Templating is a guess. Always show one URL as actually recorded so a
  // mis-templated segment (an API version read as an id, say) stays visible.
  lines.push(`Example: \`${redactUrl(group.sampleUrl).slice(0, 300)}\``);

  if (group.queryParams.size > 0) {
    lines.push("");
    lines.push("Query parameters:");
    for (const [name, value] of group.queryParams) lines.push(`- \`${name}\` = \`${value}\``);
  }

  const interesting = [...group.requestHeaders.entries()].filter(
    ([name]) => CREDENTIAL_HEADERS.has(name) || name.startsWith("x-") || name === "content-type",
  );
  if (interesting.length > 0) {
    lines.push("");
    lines.push("Request headers:");
    for (const [name, value] of interesting) lines.push(`- \`${name}\`: \`${value}\``);
  }

  if (group.graphqlQuery) {
    lines.push("");
    lines.push("Query document:");
    lines.push("```graphql");
    lines.push(group.graphqlQuery.slice(0, 1500));
    lines.push("```");
  }

  if (group.frames.length > 0) {
    // Sockets carry many repeats of a handful of message shapes, so collapse to
    // one example per distinct shape rather than dumping the whole transcript.
    const bySignature = new Map<string, { direction: string; shape: unknown; count: number }>();
    for (const frame of group.frames) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data ?? "");
      } catch {
        parsed = (frame.data ?? "").slice(0, 120);
      }
      const shape = inferShape(parsed);
      const signature = `${frame.type}:${structuralKey(parsed)}`;
      const seen = bySignature.get(signature);
      if (seen) seen.count += 1;
      else bySignature.set(signature, { direction: frame.type, shape, count: 1 });
    }

    lines.push("");
    lines.push(
      `${group.streamKind === "EventSource" ? "Event stream" : "Socket"} messages ` +
        `(${group.frames.length} frames, ${bySignature.size} distinct shapes):`,
    );
    for (const message of [...bySignature.values()].sort((a, b) => b.count - a.count).slice(0, 12)) {
      lines.push("");
      lines.push(`- ${message.direction} ×${message.count}`);
      lines.push(fence(message.shape));
    }
  }

  if (group.requestShape !== undefined) {
    lines.push("");
    lines.push("Request body:");
    lines.push(fence(group.requestShape));
  }

  if (group.responseShape !== undefined) {
    lines.push("");
    lines.push("Response body:");
    lines.push(fence(group.responseShape));
  } else {
    lines.push("");
    lines.push("_No response body captured._");
  }
}

if (groups.size > shown.length) {
  lines.push("");
  lines.push(
    `_${groups.size - shown.length} lower-ranked endpoints omitted. Re-run with \`--max-endpoints ${groups.size}\` to see them._`,
  );
}

const report = lines.join("\n");
const outPath = flag("out");
if (outPath) {
  writeFileSync(outPath, report, "utf8");
  console.log(`Wrote report to ${outPath} (${groups.size} endpoints from ${entries.length} requests).`);
} else {
  console.log(report);
}

const jsonPath = flag("json");
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        recordedRequests: entries.length,
        apiCalls: apiEntries.length,
        hosts: Object.fromEntries(hostCounts),
        auth: {
          cookieOnly: usesCookieAuth && explicitCredentialHeaders.length === 0,
          credentialHeaders: [...credentialUsage.keys()],
        },
        endpoints: ranked.map((group) => ({
          method: group.method,
          host: group.host,
          path: group.path,
          operation: group.operation,
          count: group.count,
          statuses: Object.fromEntries(group.statuses),
          queryParams: Object.fromEntries(group.queryParams),
          requestHeaders: Object.fromEntries(group.requestHeaders),
          requestShape: group.requestShape,
          responseShape: group.responseShape,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Wrote machine-readable surface to ${jsonPath}.`);
}
