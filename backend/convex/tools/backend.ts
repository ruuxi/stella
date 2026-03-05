import { tool, ToolSet } from "ai";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ToolOptions } from "./types";
import { getUnsafeIntegrationHostError } from "./network_safety";
import { executeIntegrationRequestService } from "./integration_request_service";
import { SKILLS_DISABLED_AGENT_TYPES } from "../lib/agent_constants";

const integrationAuthSchema = z
  .object({
    type: z.enum(["bearer", "header", "query", "basic"]).optional(),
    header: z.string().optional(),
    query: z.string().optional(),
    format: z.string().optional(),
    username: z.string().optional(),
  })
  .optional();

const integrationRequestSchema = z.object({
  provider: z.string().min(1),
  mode: z.enum(["public", "private"]).optional(),
  secretId: z.string().optional(),
  publicKeyEnv: z.string().optional(),
  auth: integrationAuthSchema,
  request: z.object({
    url: z.string().min(1),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.any().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  responseType: z.enum(["json", "text"]).optional(),
});

const cronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), atMs: z.number() }),
  z.object({ kind: z.literal("every"), everyMs: z.number(), anchorMs: z.number().optional() }),
  z.object({ kind: z.literal("cron"), expr: z.string(), tz: z.string().optional() }),
]);

const cronPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("systemEvent"),
    text: z.string(),
    agentType: z.string().optional(),
    deliver: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("agentTurn"),
    message: z.string(),
    agentType: z.string().optional(),
    deliver: z.boolean().optional(),
  }),
]);

const cronPatchSchema = z.object({
  name: z.string().optional(),
  schedule: cronScheduleSchema.optional(),
  payload: cronPayloadSchema.optional(),
  sessionTarget: z.string().optional(),
  conversationId: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  deleteAfterRun: z.boolean().optional(),
});

const formatResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

/**
 * Wrap external content with safety markers so the LLM knows it's untrusted.
 * Only wraps successful content responses — not error messages.
 */
const wrapExternalContent = (content: string, source: string): string =>
  `[External Content - Untrusted Source: ${source}]\n${content}\n[End External Content]`;

const BLOCKED_REQUEST_HEADER_NAME_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const BLOCKED_REQUEST_QUERY_NAME_RE =
  /^(api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password)$/i;
const SENSITIVE_RESPONSE_FIELD_NAME_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session)/i;
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const BASIC_VALUE_RE = /\bBasic\s+[A-Za-z0-9+/]+=*\b/gi;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const QUERY_SECRET_VALUE_RE =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password)=)([^&#\s]+)/gi;
const REDACTED_VALUE = "[REDACTED]";

const findBlockedCredentialHeaderName = (
  headers: z.infer<typeof integrationRequestSchema>["request"]["headers"],
): string | null => {
  if (!headers) return null;
  for (const name of Object.keys(headers)) {
    if (BLOCKED_REQUEST_HEADER_NAME_RE.test(name.trim())) {
      return name;
    }
  }
  return null;
};

const findBlockedCredentialQueryName = (
  query: z.infer<typeof integrationRequestSchema>["request"]["query"],
): string | null => {
  if (!query) return null;
  for (const name of Object.keys(query)) {
    if (BLOCKED_REQUEST_QUERY_NAME_RE.test(name.trim())) {
      return name;
    }
  }
  return null;
};

const redactResponseString = (value: string, secrets: string[]): string => {
  let output = value;
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join(REDACTED_VALUE);
  }
  output = output.replace(BEARER_VALUE_RE, "Bearer [REDACTED]");
  output = output.replace(BASIC_VALUE_RE, "Basic [REDACTED]");
  output = output.replace(JWT_VALUE_RE, REDACTED_VALUE);
  output = output.replace(QUERY_SECRET_VALUE_RE, `$1${REDACTED_VALUE}`);
  return output;
};

const redactIntegrationResponseData = (value: unknown, secrets: string[]): unknown => {
  if (typeof value === "string") {
    return redactResponseString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactIntegrationResponseData(entry, secrets));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_RESPONSE_FIELD_NAME_RE.test(key)) {
        result[key] = typeof entry === "string" ? REDACTED_VALUE : redactIntegrationResponseData(entry, secrets);
      } else {
        result[key] = redactIntegrationResponseData(entry, secrets);
      }
    }
    return result;
  }
  return value;
};

const deriveIntegrationRedactionSecrets = (
  key: string | undefined,
  auth: z.infer<typeof integrationAuthSchema> | undefined,
): string[] => {
  if (!key) {
    return [];
  }
  const authType = auth?.type ?? "bearer";
  const formatValue = (template?: string) => {
    if (!template) return key;
    return template.includes("{key}") ? template.replace("{key}", key) : `${template}${key}`;
  };
  const secrets = new Set<string>([key, `Bearer ${key}`, formatValue(auth?.format)]);
  if (authType === "basic") {
    const token = btoa(`${auth?.username ?? ""}:${key}`);
    secrets.add(token);
    secrets.add(`Basic ${token}`);
  }
  return [...secrets].filter((entry) => entry.length > 0);
};

const supportsSkillAgentType = (
  agentTypes: string[] | undefined,
  agentType: string,
) => !agentTypes || agentTypes.length === 0 || agentTypes.includes(agentType);

const applyAuth = (
  key: string,
  auth: z.infer<typeof integrationAuthSchema> | undefined,
  url: URL,
  headers: Headers,
) => {
  const authType = auth?.type ?? "bearer";
  const formatValue = (template?: string) => {
    if (!template) return key;
    return template.includes("{key}") ? template.replace("{key}", key) : `${template}${key}`;
  };

  if (authType === "query") {
    const queryName = auth?.query ?? "api_key";
    url.searchParams.set(queryName, formatValue(auth?.format));
    return;
  }

  if (authType === "basic") {
    const username = auth?.username ?? "";
    const token = btoa(`${username}:${key}`);
    headers.set("Authorization", `Basic ${token}`);
    return;
  }

  const headerName = auth?.header ?? "Authorization";
  const value =
    authType === "bearer" && !auth?.format ? `Bearer ${key}` : formatValue(auth?.format);
  headers.set(headerName, value);
};

const runIntegrationRequest = async (
  args: z.infer<typeof integrationRequestSchema>,
  key?: string,
  options?: { allowPrivateNetworkHosts?: boolean },
) => {
  let url: URL;
  try {
    url = new URL(args.request.url);
  } catch {
    return "IntegrationRequest requires a valid URL.";
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return "IntegrationRequest only supports http(s) URLs.";
  }
  const unsafeHostError = getUnsafeIntegrationHostError(url, {
    allowPrivateNetworkHosts: options?.allowPrivateNetworkHosts,
  });
  if (unsafeHostError) {
    return unsafeHostError;
  }

  const blockedHeaderName = findBlockedCredentialHeaderName(args.request.headers);
  if (blockedHeaderName) {
    return `IntegrationRequest does not accept credential headers in request.headers (${blockedHeaderName}). Use secretId + auth instead.`;
  }

  const blockedQueryName = findBlockedCredentialQueryName(args.request.query);
  if (blockedQueryName) {
    return `IntegrationRequest does not accept credential query params in request.query (${blockedQueryName}). Use secretId + auth with type \"query\" instead.`;
  }

  if (args.request.query) {
    for (const [name, value] of Object.entries(args.request.query)) {
      url.searchParams.set(name, String(value));
    }
  }

  const headers = new Headers();
  if (args.request.headers) {
    for (const [name, value] of Object.entries(args.request.headers)) {
      headers.set(name, value);
    }
  }

  if (key) {
    applyAuth(key, args.auth, url, headers);
  }

  const method = (args.request.method ?? "GET").toUpperCase();
  let body: string | undefined;
  if (args.request.body !== undefined) {
    if (typeof args.request.body === "string") {
      body = args.request.body;
    } else {
      body = JSON.stringify(args.request.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const timeoutMs = args.request.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const wantsText = args.responseType === "text";
    const wantsJson = args.responseType === "json" || contentType.includes("application/json");
    const data = wantsText
      ? await response.text()
      : wantsJson
        ? await response.json().catch(async () => await response.text())
        : await response.text();
    const redactionSecrets = deriveIntegrationRedactionSecrets(key, args.auth);
    const redactedData = redactIntegrationResponseData(data, redactionSecrets);

    return JSON.stringify(
      {
        status: response.status,
        ok: response.ok,
        data: redactedData,
      },
      null,
      2,
    );
  } catch (error) {
    return `IntegrationRequest failed: ${(error as Error).message}`;
  } finally {
    clearTimeout(timeout);
  }
};

type PublicIntegrationPolicy = {
  envVar: string;
  allowedHosts: string[];
};

const PRIVATE_HOST_PREF_PREFIX = "integration_private_hosts";

const normalizeProviderToken = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const providersCompatible = (requestedProvider: string, secretProvider: string) => {
  const requested = normalizeProviderToken(requestedProvider);
  const secret = normalizeProviderToken(secretProvider);
  if (!requested || !secret) return false;
  return requested === secret || requested.includes(secret) || secret.includes(requested);
};

const normalizeHostPattern = (value: string) =>
  value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");

const parseAllowedHosts = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : String(entry)))
      .map(normalizeHostPattern)
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map(normalizeHostPattern)
      .filter(Boolean);
  }
  return [];
};

const parsePublicPolicyCandidate = (value: unknown): PublicIntegrationPolicy | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const envVar =
    (typeof record.envVar === "string" && record.envVar.trim()) ||
    (typeof record.publicKeyEnv === "string" && record.publicKeyEnv.trim()) ||
    "";
  if (!envVar) {
    return null;
  }

  const allowedHosts = parseAllowedHosts(
    record.allowedHosts ?? record.hosts ?? record.domains,
  );
  if (allowedHosts.length === 0) {
    return null;
  }

  return { envVar, allowedHosts };
};

const parsePublicPoliciesEnv = () => {
  const raw = process.env.STELLA_PUBLIC_INTEGRATION_RULES?.trim();
  if (!raw) {
    return {} as Partial<Record<string, PublicIntegrationPolicy>>;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Partial<Record<string, PublicIntegrationPolicy>> = {};
    for (const [provider, candidate] of Object.entries(parsed)) {
      const normalized = provider.trim().toLowerCase();
      if (!normalized) continue;
      const policy = parsePublicPolicyCandidate(candidate);
      if (policy) {
        result[normalized] = policy;
      }
    }
    return result;
  } catch {
    return {} as Partial<Record<string, PublicIntegrationPolicy>>;
  }
};

const publicPoliciesFromEnv = parsePublicPoliciesEnv();

const parsePrivatePoliciesEnv = () => {
  const raw = process.env.STELLA_PRIVATE_INTEGRATION_RULES?.trim();
  if (!raw) {
    return {} as Partial<Record<string, string[]>>;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Partial<Record<string, string[]>> = {};
    for (const [provider, candidate] of Object.entries(parsed)) {
      const normalized = provider.trim().toLowerCase();
      if (!normalized) continue;
      const allowedHosts = parseAllowedHosts(candidate);
      if (allowedHosts.length > 0) {
        result[normalized] = allowedHosts;
      }
    }
    return result;
  } catch {
    return {} as Partial<Record<string, string[]>>;
  }
};

const privatePoliciesFromEnv = parsePrivatePoliciesEnv();

const hostAllowed = (hostname: string, allowedHosts: string[]) => {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;

  return allowedHosts.some((pattern) => {
    const host = normalizeHostPattern(pattern);
    if (!host) return false;
    if (host.startsWith("*.")) {
      const suffix = host.slice(2);
      if (!suffix) return false;
      return normalized === suffix || normalized.endsWith(`.${suffix}`);
    }
    return normalized === host;
  });
};

const parseStoredAllowedHosts = (value: string | null): string[] => {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parseAllowedHosts(parsed);
  } catch {
    return parseAllowedHosts(value);
  }
};

const deriveHostPatterns = (hostname: string): string[] => {
  const normalized = normalizeHostPattern(hostname);
  if (!normalized) {
    return [];
  }
  const parts = normalized.split(".");
  const patterns = new Set<string>([normalized]);
  if (parts.length >= 2 && !/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    const base = parts.slice(-2).join(".");
    patterns.add(base);
    if (base !== normalized) {
      patterns.add(`*.${base}`);
    }
  }
  return [...patterns];
};

const privateHostPrefKey = (provider: string, secretId: string) =>
  `${PRIVATE_HOST_PREF_PREFIX}:${provider}:${secretId}`;


const parsePublicPolicyFromUsagePolicy = (usagePolicy: string): PublicIntegrationPolicy | null => {
  try {
    const parsed = JSON.parse(usagePolicy) as unknown;
    return parsePublicPolicyCandidate(parsed);
  } catch {
    return null;
  }
};

export const createBackendTools = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
  const requireOwnerId = (toolName: string) => {
    if (!options.ownerId) {
      return `${toolName} requires an authenticated owner context.`;
    }
    return null;
  };

  const withSecret = async (
    secretId: string,
    toolName: string,
    handler: (secret: {
      secretId: Id<"secrets">;
      provider: string;
      label: string;
      plaintext: string;
      status: string;
      metadata?: unknown;
    }) => Promise<string>,
  ) => {
    if (!secretId || secretId === "undefined" || secretId === "null") {
      return `${toolName} requires a secretId.`;
    }
    const ownerCheck = requireOwnerId(toolName);
    if (ownerCheck) {
      return ownerCheck;
    }

    const ownerId = options.ownerId as string;
    const requestId = crypto.randomUUID();
    try {
      const secret = await ctx.runQuery(internal.data.secrets.getSecretForTool, {
        ownerId,
        secretId: secretId as Id<"secrets">,
      });
      await ctx.runMutation(internal.data.secrets.touchSecretUsage, {
        ownerId,
        secretId: secretId as Id<"secrets">,
      });
      await ctx.runMutation(internal.data.secrets.auditSecretAccess, {
        ownerId,
        secretId: secretId as Id<"secrets">,
        toolName,
        requestId,
        status: "allowed",
      });
      return await handler(secret);
    } catch (error) {
      try {
        await ctx.runMutation(internal.data.secrets.auditSecretAccess, {
          ownerId,
          secretId: secretId as Id<"secrets">,
          toolName,
          requestId,
          status: "denied",
          reason: (error as Error).message,
        });
      } catch {
        // Ignore audit failures.
      }
      return `Secret access failed for ${toolName}.`;
    }
  };

  const stripHtml = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const truncateText = (value: string, max = 30_000) =>
    value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;

  return {
    WebSearch: tool({
      description:
        "Search the web for current information.\n\n" +
        "Usage:\n" +
        "- Returns up to 6 results with title, URL, and text snippet.\n" +
        "- Use for questions requiring up-to-date information beyond training data.\n" +
        "- query should be a natural language search phrase.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Search query (natural language)"),
      }),
      execute: async (args) => {
        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
          return "WebSearch is not configured (missing EXA_API_KEY).";
        }
        try {
          const response = await fetch("https://api.exa.ai/search", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: args.query,
              type: "auto",
              numResults: 6,
              contents: {
                text: { maxCharacters: 1000 },
              },
            }),
          });
          if (!response.ok) {
            return `WebSearch failed (${response.status}): ${await response.text()}`;
          }
          const data = (await response.json()) as {
            results?: Array<{
              title?: string;
              url?: string;
              text?: string;
            }>;
          };
          const results = data.results ?? [];
          if (results.length === 0) {
            return `No web results found for "${args.query}".`;
          }
          const formatted = results
            .map((r, i) => {
              const parts = [`${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url ?? ""}`];
              if (r.text) parts.push(`   ${r.text.slice(0, 300)}`);
              return parts.join("\n");
            })
            .join("\n\n");
          return wrapExternalContent(
            `Web search results for "${args.query}":\n\n${formatted}`,
            `web search: ${args.query}`,
          );
        } catch (error) {
          return `WebSearch failed: ${(error as Error).message}`;
        }
      },
    }),
    WebFetch: tool({
      description:
        "Fetch and read content from a URL.\n\n" +
        "Usage:\n" +
        "- Fetches the page content, strips HTML tags, and returns plain text.\n" +
        "- HTTP URLs are auto-upgraded to HTTPS.\n" +
        "- prompt describes what information you want to extract — it's returned alongside the content for context.\n" +
        "- Content is truncated to 15,000 characters.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch (HTTP auto-upgrades to HTTPS)"),
        prompt: z.string().describe("What information you want from this page"),
      }),
      execute: async (args) => {
        const secureUrl = args.url.replace(/^http:/, "https:");
        try {
          const response = await fetch(secureUrl, {
            headers: { "User-Agent": "StellaBackend/1.0" },
          });
          if (!response.ok) {
            return `Failed to fetch (${response.status} ${response.statusText})`;
          }
          const text = await response.text();
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("text/html") ? stripHtml(text) : text;
          return wrapExternalContent(
            `Content from ${secureUrl}\nPrompt: ${args.prompt}\n\n${truncateText(body, 15_000)}`,
            secureUrl,
          );
        } catch (error) {
          return `Error fetching URL: ${(error as Error).message}`;
        }
      },
    }),
    IntegrationRequest: tool({
      description:
        "Send an HTTP request to an external API using stored credentials.\n\n" +
        "Usage:\n" +
        "- Two modes: \"public\" (uses a provider-scoped Stella-managed env var + allowed hosts policy) or \"private\" (uses a user's secretId from RequestCredential).\n" +
        "- Auth types: \"bearer\" (default, adds Authorization: Bearer header), \"header\" (custom header), \"query\" (adds to URL params), \"basic\" (HTTP Basic Auth).\n" +
        "- Never put raw API keys/tokens/cookies in request.headers or request.query. Always pass secretId + auth so secret material stays server-side.\n" +
        "- Response is returned as JSON with status, ok, and data fields.",
      inputSchema: integrationRequestSchema,
      execute: async (args) => {
        return await executeIntegrationRequestService({
          request: args,
          wrapExternalContent,
          readEnv: (name) => process.env[name],
          hostAllowed,
          deriveHostPatterns,
          providersCompatible,
          runIntegrationRequest,
          lookupPublicPolicy: async (provider) => {
            const providerKey = provider.trim().toLowerCase();
            let policy = publicPoliciesFromEnv[providerKey] ?? null;
            if (!policy) {
              const publicIntegration = await ctx.runQuery(
                internal.data.integrations.getPublicIntegrationById,
                { id: provider },
              );
              if (publicIntegration?.usagePolicy) {
                policy = parsePublicPolicyFromUsagePolicy(publicIntegration.usagePolicy);
              }
            }
            return policy;
          },
          lookupPrivateAllowedHosts: async (providerKey, secretId) => {
            const envPolicyHosts = privatePoliciesFromEnv[providerKey] ?? [];
            if (envPolicyHosts.length > 0) {
              return envPolicyHosts;
            }
            const ownerId = options.ownerId as string;
            const prefValue = await ctx.runQuery(
              internal.data.preferences.getPreferenceForOwner,
              {
                ownerId,
                key: privateHostPrefKey(providerKey, secretId),
              },
            );
            return parseStoredAllowedHosts(prefValue);
          },
          persistPrivateAllowedHosts: async (providerKey, secretId, hosts) => {
            const ownerId = options.ownerId as string;
            await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
              ownerId,
              key: privateHostPrefKey(providerKey, secretId),
              value: JSON.stringify(hosts),
            });
          },
          requireOwnerContextError: () => requireOwnerId("IntegrationRequest"),
          withSecret: async (secretId, handler) =>
            await withSecret(secretId, "IntegrationRequest", async (secret) =>
              await handler({
                ...secret,
                secretId: String(secret.secretId),
              }),
            ),
        });
      },
    }),
    ActivateSkill: tool({
      description:
        "Load a skill's full instructions into context.\n\n" +
        "Usage:\n" +
        "- Skills are listed in the system prompt by name and description.\n" +
        "- Call this to load the full markdown instructions for a skill.\n" +
        "- Always activate a skill before following its workflow guidance.\n" +
        "- If the skill has secretMounts, use SkillBash (not Bash) for commands that need those secrets.",
      inputSchema: z.object({
        skill_id: z.string().min(1).describe("Skill ID from the skills listing in the system prompt"),
      }),
      execute: async (args) => {
        if (SKILLS_DISABLED_AGENT_TYPES.has(options.agentType)) {
          return `Skills are unavailable for agent type "${options.agentType}".`;
        }
        const skill = await ctx.runQuery(internal.data.skills.getSkillByIdInternal, {
          skillId: args.skill_id,
          ownerId: options.ownerId,
        });
        if (!skill) {
          return `Skill not found: ${args.skill_id}`;
        }
        if (!skill.enabled) {
          return `Skill is disabled: ${args.skill_id}`;
        }
        if (!supportsSkillAgentType(skill.agentTypes, options.agentType)) {
          return `Skill "${skill.id}" is not available for agent type "${options.agentType}".`;
        }
        const parts = [`## Skill: ${skill.name} (${skill.id})`];
        if (skill.requiresSecrets && skill.requiresSecrets.length > 0) {
          parts.push(
            `Requires credentials: ${skill.requiresSecrets.join(", ")}. Use RequestCredential if missing.`,
          );
        }
        if (skill.execution) {
          parts.push(`Execution: ${skill.execution}-only.`);
        }
        if (skill.secretMounts) {
          parts.push(
            "Use SkillBash for local commands so secrets are mounted automatically.",
          );
        }
        parts.push(skill.markdown);
        return parts.join("\n\n");
      },
    }),
    HeartbeatGet: tool({
      description:
        "Get the current heartbeat configuration for a conversation.\n\n" +
        "Returns the full config (interval, checklist, active hours, enabled status, last run info) or null if no heartbeat is configured.",
      inputSchema: z.object({
        conversationId: z.string().optional(),
      }),
      execute: async (args) => {
        const result = await ctx.runQuery(internal.scheduling.heartbeat.getConfig, {
          ...(args.conversationId ? { conversationId: args.conversationId as Id<"conversations"> } : {}),
        });
        return formatResult(result);
      },
    }),
    HeartbeatUpsert: tool({
      description:
        "Create or update the heartbeat configuration for periodic monitoring.\n\n" +
        "Usage:\n" +
        "- One heartbeat per conversation. Creates a new config or updates the existing one.\n" +
        "- intervalMs: how often to poll (minimum 60000ms = 1 min, default 30 min).\n" +
        "- checklist: markdown checklist you'll read on each poll. Write as instructions to yourself.\n" +
        "- activeHours: quiet hours window (start/end in HH:MM, with optional timezone). Heartbeats outside this window are silently skipped.\n" +
        "- deliver: set to false to run silently without posting to conversation (default true).\n" +
        "- Only specified fields are changed on update — omitted fields are preserved.",
      inputSchema: z.object({
        conversationId: z.string().optional(),
        enabled: z.boolean().optional(),
        intervalMs: z.number().optional(),
        prompt: z.string().optional(),
        checklist: z.string().optional(),
        ackMaxChars: z.number().optional(),
        deliver: z.boolean().optional(),
        agentType: z.string().optional(),
        activeHours: z.object({
          start: z.string(),
          end: z.string(),
          timezone: z.string().optional(),
        }).optional(),
        targetDeviceId: z.string().optional(),
      }),
      execute: async (args) => {
        const { conversationId, ...rest } = args;
        const result = await ctx.runMutation(internal.scheduling.heartbeat.upsertConfig, {
          ...rest,
          ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
        });
        return formatResult(result);
      },
    }),
    HeartbeatRun: tool({
      description:
        "Trigger an immediate heartbeat run without waiting for the next interval.\n\n" +
        "Useful for testing a heartbeat config or when the user says \"check now\".",
      inputSchema: z.object({
        conversationId: z.string().optional(),
      }),
      execute: async (args) => {
        const result = await ctx.runMutation(internal.scheduling.heartbeat.runNow, {
          ...(args.conversationId ? { conversationId: args.conversationId as Id<"conversations"> } : {}),
        });
        return formatResult(result);
      },
    }),
    CronList: tool({
      description:
        "List all cron jobs for the current user.\n\n" +
        "Returns up to 200 jobs (newest first) with their schedule, payload, status, and next run time.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await ctx.runQuery(internal.scheduling.cron_jobs.list, {});
        return formatResult(result);
      },
    }),
    CronAdd: tool({
      description:
        "Create a new scheduled cron job.\n\n" +
        "Usage:\n" +
        "- Schedule types: { kind: \"at\", atMs } for one-shot, { kind: \"every\", everyMs } for interval, { kind: \"cron\", expr, tz? } for cron expressions.\n" +
        "- Payload types: { kind: \"systemEvent\", text } for lightweight events, { kind: \"agentTurn\", message } for full agent execution.\n" +
        "- CONSTRAINT: sessionTarget=\"main\" requires systemEvent payload. sessionTarget=\"isolated\" requires agentTurn payload.\n" +
        "- deleteAfterRun=true auto-deletes \"at\" jobs after successful execution.\n" +
        "- Write text/message so it reads naturally at fire time (e.g. \"Reminder: You wanted to call the dentist today.\").",
      inputSchema: z.object({
        name: z.string(),
        schedule: cronScheduleSchema,
        payload: cronPayloadSchema,
        sessionTarget: z.string(),
        conversationId: z.string().optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        deleteAfterRun: z.boolean().optional(),
      }),
      execute: async (args) => {
        const result = await ctx.runMutation(internal.scheduling.cron_jobs.add, {
          name: args.name,
          schedule: args.schedule,
          payload: args.payload,
          sessionTarget: args.sessionTarget,
          ...(args.conversationId ? { conversationId: args.conversationId as Id<"conversations"> } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.deleteAfterRun !== undefined ? { deleteAfterRun: args.deleteAfterRun } : {}),
        });
        return formatResult(result);
      },
    }),
    CronUpdate: tool({
      description:
        "Update an existing cron job.\n\n" +
        "Usage:\n" +
        "- Only include fields you want to change in the patch — omitted fields are preserved.\n" +
        "- Recomputes the next run time on any update.",
      inputSchema: z.object({
        jobId: z.string(),
        patch: cronPatchSchema,
      }),
      execute: async (args) => {
        const { conversationId, ...restPatch } = args.patch;
        const result = await ctx.runMutation(internal.scheduling.cron_jobs.update, {
          jobId: args.jobId as Id<"cron_jobs">,
          patch: {
            ...restPatch,
            ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
          },
        });
        return formatResult(result);
      },
    }),
    CronRemove: tool({
      description: "Permanently delete a cron job.",
      inputSchema: z.object({
        jobId: z.string(),
      }),
      execute: async (args) => {
        await ctx.runMutation(internal.scheduling.cron_jobs.remove, {
          jobId: args.jobId as Id<"cron_jobs">,
        });
        return "Cron job removed.";
      },
    }),
    CronRun: tool({
      description:
        "Trigger an immediate run of a cron job, ignoring its schedule.\n\n" +
        "The job executes now regardless of enabled status or next run time.",
      inputSchema: z.object({
        jobId: z.string(),
      }),
      execute: async (args) => {
        const result = await ctx.runMutation(internal.scheduling.cron_jobs.run, {
          jobId: args.jobId as Id<"cron_jobs">,
        });
        return formatResult(result);
      },
    }),
    GenerateApiSkill: tool({
      description:
        "Convert a browser-discovered API map into a reusable skill.\n\n" +
        "Usage:\n" +
        "- Called after the Browser agent returns a structured API map from network interception.\n" +
        "- Creates a persistent skill with endpoint docs, auth config, and usage instructions.\n" +
        "- The skill can be activated in future conversations via ActivateSkill.\n" +
        "- canvasHint suggests how to visualize API data: \"table\", \"chart\", \"feed\", \"player\", \"dashboard\".\n" +
        "- Use IntegrationRequest to actually call the discovered endpoints.",
      inputSchema: z.object({
        service: z.string().describe("Service name (e.g. 'Spotify')"),
        baseUrl: z.string().describe("API base URL"),
        auth: z
          .object({
            type: z
              .string()
              .describe("Auth type: bearer, cookie, header, oauth"),
            tokenSource: z
              .string()
              .optional()
              .describe("Where the token comes from"),
            headerName: z
              .string()
              .optional()
              .describe("Header name for auth"),
            notes: z
              .string()
              .optional()
              .describe("Refresh, expiry, etc."),
          })
          .optional(),
        endpoints: z.array(
          z.object({
            path: z.string(),
            method: z.string().optional(),
            description: z.string().optional(),
            params: z.record(z.string()).optional(),
            responseShape: z.string().optional(),
            rateLimit: z.string().optional(),
          }),
        ),
        sessionNotes: z.string().optional(),
        skillId: z
          .string()
          .optional()
          .describe(
            "Custom skill ID (auto-generated from service name if omitted)",
          ),
        tags: z.array(z.string()).optional(),
        canvasHint: z
          .string()
          .optional()
          .describe(
            "Suggested canvas for results: table, chart, feed, player, dashboard",
          ),
      }),
      execute: async (args) => {
        const skillId =
          args.skillId ??
          args.service
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") +
            "-api";

        const lines: string[] = [];
        lines.push(`# ${args.service} API`);
        lines.push("");
        lines.push(`Discovered API integration for ${args.service}.`);
        lines.push("");
        lines.push("## Base URL");
        lines.push(`\`${args.baseUrl}\``);
        lines.push("");

        if (args.auth) {
          lines.push("## Authentication");
          lines.push(`- **Type**: ${args.auth.type}`);
          if (args.auth.headerName)
            lines.push(`- **Header**: ${args.auth.headerName}`);
          if (args.auth.tokenSource)
            lines.push(`- **Source**: ${args.auth.tokenSource}`);
          if (args.auth.notes)
            lines.push(`- **Notes**: ${args.auth.notes}`);
          lines.push("");
        }

        lines.push("## Endpoints");
        lines.push("");
        for (const ep of args.endpoints) {
          const method = (ep.method ?? "GET").toUpperCase();
          lines.push(`### ${method} ${ep.path}`);
          if (ep.description) lines.push(ep.description);
          if (ep.params && Object.keys(ep.params).length > 0) {
            lines.push("**Parameters:**");
            for (const [key, desc] of Object.entries(ep.params)) {
              lines.push(`- \`${key}\`: ${desc}`);
            }
          }
          if (ep.responseShape)
            lines.push(`**Response:** ${ep.responseShape}`);
          if (ep.rateLimit)
            lines.push(`**Rate limit:** ${ep.rateLimit}`);
          lines.push("");
        }

        lines.push("## Usage");
        lines.push("");
        lines.push("Call endpoints using `IntegrationRequest`:");
        lines.push("```");
        lines.push("IntegrationRequest({");
        lines.push(`  provider: "${skillId}",`);
        if (args.auth) {
          const authType =
            args.auth.type === "cookie" ? "header" : args.auth.type;
          lines.push(
            `  auth: { type: "${authType}"${args.auth.headerName ? `, header: "${args.auth.headerName}"` : ""} },`,
          );
        }
        lines.push("  request: {");
        lines.push(`    url: "${args.baseUrl}<endpoint_path>",`);
        lines.push('    method: "GET",');
        lines.push("  }");
        lines.push("})");
        lines.push("```");
        lines.push("");
        lines.push(
          "If no credentials are stored, use `RequestCredential` to obtain them, or delegate to the browser agent to extract tokens from an active session.",
        );

        if (args.sessionNotes) {
          lines.push("");
          lines.push("## Session Notes");
          lines.push(args.sessionNotes);
        }

        if (args.canvasHint) {
          lines.push("");
          lines.push("## Display");
          lines.push(
            `Suggested visualization: **${args.canvasHint}**`,
          );
          lines.push(
            "Write a panel TSX file for the visualization, then report the panel name so the user can find it in the workspace/home pages.",
          );
        }

        const markdown = lines.join("\n");
        const requiresSecrets: string[] = [];
        if (args.auth && args.auth.type !== "cookie") {
          requiresSecrets.push(skillId);
        }

        await ctx.runMutation(internal.data.skills.upsertManyInternal, {
          skills: [
            {
              id: skillId,
              name: `${args.service} API`,
              description: `API integration for ${args.service} — ${args.endpoints.length} endpoints`,
              markdown,
              agentTypes: ["general"],
              tags: args.tags ?? ["api", "integration", "generated"],
              requiresSecrets:
                requiresSecrets.length > 0 ? requiresSecrets : undefined,
              source: "generated",
              enabled: true,
            },
          ],
        });

        return `Skill "${skillId}" created with ${args.endpoints.length} endpoints.\n\nAgents can now use ActivateSkill("${skillId}") to activate the ${args.service} API skill and call endpoints via IntegrationRequest.`;
      },
    }),
    ListResources: tool({
      description:
        "List stored resources the user has configured.\n\n" +
        "Usage:\n" +
        "- type: \"credentials\" — lists stored API keys and secrets (provider, label, status). No plaintext is returned.\n" +
        "- Use this to check what credentials exist before calling RequestCredential.\n" +
        "- For panels and workspace apps, use Glob on `frontend/workspace/panels/` and `~/.stella/apps/` instead.",
      inputSchema: z.object({
        type: z.enum(["credentials"]).describe("Resource type to list"),
      }),
      execute: async (args) => {
        if (args.type === "credentials") {
          const ownerCheck = requireOwnerId("ListResources");
          if (ownerCheck) return ownerCheck;

          const secrets = await ctx.runQuery(internal.data.secrets.listSecretsInternal, {
            ownerId: options.ownerId as string,
          });

          if (secrets.length === 0) {
            return "No stored credentials found. Use RequestCredential to store API keys.";
          }

          const formatted = secrets
            .map(
              (s: {
                  label: string;
                  provider: string;
                  status: string;
                  lastUsedAt?: number;
                },
                i: number,) =>
                `${i + 1}. **${s.label}** (${s.provider}) — ${s.status}${s.lastUsedAt ? ` | last used ${new Date(s.lastUsedAt).toISOString()}` : ""}`,
            )
            .join("\n");

          return `Found ${secrets.length} stored credential(s):\n\n${formatted}`;
        }

        return `Unknown resource type: ${args.type}`;
      },
    }),
    NoResponse: tool({
      description:
        "Signal that you have nothing to say to the user right now. " +
        "Call this instead of generating a message when a system event, task result, or heartbeat check " +
        "does not warrant a visible response. Do NOT call this for user messages — always reply to users.",
      inputSchema: z.object({}),
      execute: async () => {
        return "__NO_RESPONSE__";
      },
    }),
  };
};


