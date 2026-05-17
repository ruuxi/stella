#!/usr/bin/env node
import { execFile } from "node:child_process";
import { platform } from "node:os";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type RpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
};

type ComposioToolSchema = {
  slug?: string;
  name?: string;
  description?: string;
  input_parameters?: Record<string, unknown>;
  inputParameters?: Record<string, unknown>;
};

type ComposioConnectedAccount = {
  id?: string;
  status?: string;
  created_at?: string;
  toolkit?: string | { slug?: string; name?: string };
  toolkit_slug?: string;
};

const COMPOSIO_API_BASE =
  process.env.COMPOSIO_API_BASE ?? "https://backend.composio.dev/api/v3";

const parseOptions = (argv: string[]) => {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) continue;
    const eqIndex = entry.indexOf("=");
    if (eqIndex > -1) {
      options[entry.slice(2, eqIndex)] = entry.slice(eqIndex + 1);
      continue;
    }
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
};

const optionString = (
  options: Record<string, string | boolean>,
  key: string,
) => {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
};

const options = parseOptions(process.argv.slice(2));
const toolkit = optionString(options, "toolkit")?.trim();
const entityId = optionString(options, "entity-id")?.trim() || "default";
// STELLA-GUARD: composio-api-key
// This key authorizes Composio account linking and app actions. Do not log it,
// expose it to tools, or change this path to print/request secrets from prompts.
const apiKey = process.env.COMPOSIO_API_KEY?.trim();

if (!toolkit) {
  process.stderr.write("composio-mcp: --toolkit is required\n");
  process.exit(1);
}

const jsonResponse = (id: string | number, result: unknown) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const jsonError = (id: string | number, message: string, code = -32000) => {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
};

const endpoint = (path: string) => `${COMPOSIO_API_BASE}${path}`;

const requireApiKey = () => {
  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is required. Save it as the composio.api_key connector credential.",
    );
  }
  return apiKey;
};

const requestJson = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const url = endpoint(path);
  if (!url.startsWith("https://")) {
    throw new Error("Refusing to send Composio credentials over non-HTTPS.");
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": requireApiKey(),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Composio request failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
};

const getToolSlug = (item: ComposioToolSchema) =>
  (item.slug ?? item.name ?? "").trim();

const listComposioTools = async () => {
  const params = new URLSearchParams({
    limit: "200",
    toolkits: toolkit,
  });
  const body = await requestJson<{ items?: ComposioToolSchema[] }>(
    `/tools?${params.toString()}`,
  );
  return (body.items ?? [])
    .filter((item) => getToolSlug(item))
    .map((item) => {
      const name = getToolSlug(item);
      return {
        name,
        description: item.description ?? `Run ${name} through Composio.`,
        inputSchema: item.input_parameters ??
          item.inputParameters ?? {
            type: "object",
            properties: {},
          },
      };
    });
};

const toolkitSlugForAccount = (account: ComposioConnectedAccount) => {
  if (account.toolkit_slug) return account.toolkit_slug;
  if (typeof account.toolkit === "string") return account.toolkit;
  return account.toolkit?.slug ?? "";
};

const listConnections = async () => {
  const params = new URLSearchParams({ limit: "200" });
  const body = await requestJson<{ items?: ComposioConnectedAccount[] }>(
    `/connected_accounts?${params.toString()}`,
  );
  return (body.items ?? []).filter(
    (account) => toolkitSlugForAccount(account) === toolkit,
  );
};

const resolveAuthConfigId = async () => {
  const params = new URLSearchParams({
    toolkit_slug: toolkit,
    show_disabled: "true",
    limit: "25",
  });
  const body = await requestJson<{
    items?: Array<{ id?: string; status?: string; enabled?: boolean }>;
  }>(`/auth_configs?${params.toString()}`);
  const items = (body.items ?? []).filter((entry) => entry.id);
  const preferred =
    items.find(
      (entry) =>
        entry.enabled === true ||
        entry.status?.toLowerCase() === "enabled" ||
        entry.status?.toLowerCase() === "active",
    ) ?? items[0];
  if (!preferred?.id) {
    throw new Error(
      `No Composio auth config found for ${toolkit}. Create one in Composio first.`,
    );
  }
  return preferred.id;
};

const extractRedirectUrl = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["redirect_url", "redirectUrl", "url", "link"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  for (const nested of ["data", "connection", "connected_account"]) {
    const found = extractRedirectUrl(record[nested]);
    if (found) return found;
  }
  return undefined;
};

const openExternal = async (url: string) => {
  const command =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

const connectToolkit = async (args: Record<string, unknown>) => {
  const authConfigId =
    typeof args.auth_config_id === "string" && args.auth_config_id.trim()
      ? args.auth_config_id.trim()
      : await resolveAuthConfigId();
  const body = await requestJson<unknown>("/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id:
        typeof args.user_id === "string" && args.user_id.trim()
          ? args.user_id.trim()
          : entityId,
    }),
  });
  const url = extractRedirectUrl(body);
  if (!url) {
    throw new Error("Composio did not return an OAuth URL.");
  }
  const shouldOpen = args.open !== false;
  if (shouldOpen) await openExternal(url);
  return {
    content: [
      {
        type: "text",
        text: shouldOpen
          ? `Opened ${toolkit} authorization in your browser.`
          : `Authorize ${toolkit}: ${url}`,
      },
    ],
    structuredContent: { url, opened: shouldOpen },
  };
};

const executeTool = async (name: string, args: Record<string, unknown>) => {
  const {
    _connected_account_id: privateConnectedAccountId,
    connected_account_id: connectedAccountId,
    connectedAccountId: camelConnectedAccountId,
    ...toolArguments
  } = args;
  const accountRef =
    typeof privateConnectedAccountId === "string" &&
    privateConnectedAccountId.trim()
      ? privateConnectedAccountId.trim()
      : typeof connectedAccountId === "string" && connectedAccountId.trim()
        ? connectedAccountId.trim()
        : typeof camelConnectedAccountId === "string" &&
            camelConnectedAccountId.trim()
          ? camelConnectedAccountId.trim()
          : undefined;
  const body = await requestJson<JsonValue>(
    `/tools/${encodeURIComponent(name)}/execute`,
    {
      method: "POST",
      body: JSON.stringify({
        arguments: toolArguments,
        user_id: entityId,
        ...(accountRef ? { connected_account_id: accountRef } : {}),
      }),
    },
  );
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
};

const staticTools = () => [
  {
    name: "connect",
    description: `Open the OAuth authorization page for ${toolkit}.`,
    inputSchema: {
      type: "object",
      properties: {
        open: {
          type: "boolean",
          description: "Open the authorization URL in the default browser.",
          default: true,
        },
        auth_config_id: {
          type: "string",
          description: "Optional Composio auth config id.",
        },
        user_id: {
          type: "string",
          description:
            "Optional Composio user id. Defaults to this Stella profile.",
        },
      },
    },
  },
  {
    name: "list_connections",
    description: `List connected Composio accounts for ${toolkit}.`,
    inputSchema: { type: "object", properties: {} },
  },
];

const handleRequest = async (message: RpcMessage) => {
  const id = message.id ?? 0;
  try {
    switch (message.method) {
      case "initialize":
        jsonResponse(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `stella-composio-${toolkit}`, version: "0.1.0" },
        });
        return;
      case "tools/list":
        jsonResponse(id, {
          tools: [...staticTools(), ...(await listComposioTools())],
        });
        return;
      case "tools/call": {
        const params = (message.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const name = params.name?.trim();
        const args = params.arguments ?? {};
        if (!name) throw new Error("tools/call requires a tool name.");
        if (name === "connect") {
          jsonResponse(id, await connectToolkit(args));
        } else if (name === "list_connections") {
          const connections = await listConnections();
          jsonResponse(id, {
            content: [
              { type: "text", text: JSON.stringify(connections, null, 2) },
            ],
            structuredContent: { connections },
          });
        } else {
          jsonResponse(id, await executeTool(name, args));
        }
        return;
      }
      default:
        jsonError(id, `Unknown method: ${message.method}`, -32601);
    }
  } catch (error) {
    jsonError(id, error instanceof Error ? error.message : String(error));
  }
};

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) return;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    void handleRequest(message);
  }
});
