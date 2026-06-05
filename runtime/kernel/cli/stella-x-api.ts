#!/usr/bin/env node

type CliOptions = {
  command: string;
  method?: string;
  path?: string;
  query?: string;
  body?: string;
  json: boolean;
  limit?: number;
};

type SiteAuth = {
  baseUrl: string;
  authToken: string;
};

const usage = `stella-x-api - use X (Twitter) through Stella's connected account

Usage:
  stella-x-api connect [--json]
  stella-x-api status [--json]
  stella-x-api whoami [--json]
  stella-x-api request <x-api-v2-path> [--method GET|POST|PUT|PATCH|DELETE] [--query '{}'] [--body '{}']
  stella-x-api post "text" [--json]
  stella-x-api read <post-id-or-url> [--json]
  stella-x-api search "query" [-n 10] [--json]

Environment:
  STELLA_X_API_BASE_URL       Stella site base URL
  STELLA_X_API_AUTH_TOKEN     Stella bearer token
`;

const printJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const parseJson = <T>(value: string | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    fail(`Invalid JSON: ${(error as Error).message}`);
  }
  return fallback;
};

const parseArgs = (argv: string[]): CliOptions => {
  const [command = "help", ...rest] = argv;
  const options: CliOptions = {
    command: command === "-h" || command === "--help" ? "help" : command,
    json: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--method":
      case "-X":
        options.method = rest[++i];
        break;
      case "--query":
        options.query = rest[++i];
        break;
      case "--body":
      case "--data":
      case "-d":
        options.body = rest[++i];
        break;
      case "-n":
      case "--limit": {
        const parsed = Number(rest[++i]);
        if (Number.isFinite(parsed) && parsed > 0) {
          options.limit = Math.floor(parsed);
        }
        break;
      }
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        positionals.push(arg);
        break;
    }
  }
  if (positionals[0]) options.path = positionals[0];
  if (positionals.length > 1 && !options.body) {
    options.body = positionals.slice(1).join(" ");
  }
  return options;
};

const getAuth = (): SiteAuth => {
  const baseUrl =
    process.env.STELLA_X_API_BASE_URL?.trim() ||
    process.env.STELLA_SITE_URL?.trim() ||
    process.env.STELLA_LLM_PROXY_URL?.trim() ||
    "";
  const authToken =
    process.env.STELLA_X_API_AUTH_TOKEN?.trim() ||
    process.env.STELLA_AUTH_TOKEN?.trim() ||
    process.env.STELLA_LLM_PROXY_TOKEN?.trim() ||
    "";
  if (!baseUrl || !authToken) {
    throw new Error(
      "stella-x-api requires Stella sign-in. Open Stella and finish signing in, then retry.",
    );
  }
  return { baseUrl, authToken };
};

const stellaUrl = (baseUrl: string, pathname: string): string =>
  new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const fetchJson = async <T>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `Request failed with status ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
};

const requestHeaders = (auth: SiteAuth): Record<string, string> => ({
  Authorization: `Bearer ${auth.authToken}`,
  "Content-Type": "application/json",
});

const callStellaX = async (
  auth: SiteAuth,
  body: Record<string, unknown>,
): Promise<unknown> =>
  await fetchJson(stellaUrl(auth.baseUrl, "/api/x/request"), {
    method: "POST",
    headers: requestHeaders(auth),
    body: JSON.stringify(body),
  });

const extractPostId = (value: string): string => {
  const match = value.match(/(?:status|statuses)\/(\d+)/u) ?? value.match(/^(\d+)$/u);
  const postId = match?.[1];
  if (typeof postId === "string") return postId;
  return fail("Expected an X post id or URL.");
};

const connect = async (options: CliOptions) => {
  const auth = getAuth();
  const payload = await fetchJson<{ url: string; expiresAt: number }>(
    stellaUrl(auth.baseUrl, "/api/x/connect-url"),
    { method: "GET", headers: requestHeaders(auth) },
  );
  if (options.json) {
    printJson(payload);
    return;
  }
  process.stdout.write(`${payload.url}\n`);
};

const status = async (options: CliOptions) => {
  const auth = getAuth();
  const payload = await fetchJson(
    stellaUrl(auth.baseUrl, "/api/x/connections"),
    { method: "GET", headers: requestHeaders(auth) },
  );
  if (options.json) {
    printJson(payload);
    return;
  }
  const connections = (payload as { connections?: Array<{ username?: string }> })
    .connections ?? [];
  if (connections.length === 0) {
    process.stdout.write("X is not connected. Run: stella-x-api connect\n");
    return;
  }
  process.stdout.write(
    connections
      .map((connection) => `Connected @${connection.username ?? "unknown"}`)
      .join("\n") + "\n",
  );
};

const request = async (options: CliOptions) => {
  if (!options.path) fail("Usage: stella-x-api request <x-api-v2-path>");
  const auth = getAuth();
  const payload = await callStellaX(auth, {
    path: options.path,
    method: options.method ?? "GET",
    query: parseJson(options.query, {}),
    ...(options.body
      ? { body: parseJson(options.body, { text: options.body }) }
      : {}),
  });
  printJson(payload);
};

const whoami = async () => {
  const payload = await callStellaX(getAuth(), {
    path: "/2/users/me",
    query: { "user.fields": "id,name,username,description,public_metrics,verified" },
  });
  printJson(payload);
};

const post = async (options: CliOptions) => {
  const text = options.path;
  if (!text) fail('Usage: stella-x-api post "text"');
  const payload = await callStellaX(getAuth(), {
    path: "/2/tweets",
    method: "POST",
    body: { text },
  });
  printJson(payload);
};

const readPost = async (options: CliOptions) => {
  const raw = options.path;
  if (typeof raw !== "string") {
    return fail("Usage: stella-x-api read <post-id-or-url>");
  }
  const postId = extractPostId(raw);
  const payload = await callStellaX(getAuth(), {
    path: `/2/tweets/${postId}`,
    query: {
      expansions: "author_id,attachments.media_keys,referenced_tweets.id",
      "tweet.fields":
        "article,attachments,conversation_id,created_at,entities,public_metrics,referenced_tweets",
      "user.fields": "id,name,username,verified",
      "media.fields": "duration_ms,height,preview_image_url,type,url,width",
    },
  });
  printJson(payload);
};

const search = async (options: CliOptions) => {
  const query = options.path;
  if (!query) fail('Usage: stella-x-api search "query" [-n 10]');
  const payload = await callStellaX(getAuth(), {
    path: "/2/tweets/search/recent",
    query: {
      query,
      max_results: Math.max(10, Math.min(options.limit ?? 10, 100)),
      expansions: "author_id,attachments.media_keys",
      "tweet.fields": "attachments,conversation_id,created_at,entities,public_metrics",
      "user.fields": "id,name,username,verified",
      "media.fields": "duration_ms,height,preview_image_url,type,url,width",
    },
  });
  printJson(payload);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "connect":
      await connect(options);
      break;
    case "status":
      await status(options);
      break;
    case "request":
      await request(options);
      break;
    case "whoami":
      await whoami();
      break;
    case "post":
      await post(options);
      break;
    case "read":
      await readPost(options);
      break;
    case "search":
      await search(options);
      break;
    case "help":
      process.stdout.write(usage);
      break;
    default:
      fail(`Unknown command: ${options.command}\n\n${usage}`);
  }
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
