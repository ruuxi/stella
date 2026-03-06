/**
 * Shared BYOK (Bring Your Own Key) resolution utilities.
 *
 * Used by both model_resolver.ts (AI SDK model instances) and
 * ai_proxy.ts (transparent HTTP proxy) to resolve API keys through
 * a unified lookup chain: user key → OpenRouter → env var.
 */

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getProviderSecretKey } from "./providers";

type KeyLookupCtx = { runQuery: ActionCtx["runQuery"] };

/** Look up a user's decrypted API key for a given provider DB key (e.g. "llm:anthropic"). */
export async function getUserProviderKey(
  ctx: KeyLookupCtx,
  ownerId: string,
  secretKey: string,
): Promise<string | null> {
  try {
    return await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
      ownerId,
      provider: secretKey,
    });
  } catch {
    return null;
  }
}

export type ByokKeyResult = {
  apiKey: string;
  source: "direct" | "openrouter";
};

/**
 * Resolve a raw API key through the BYOK chain.
 *
 * 1. Direct provider key (if the provider has a registered secret key)
 * 2. OpenRouter fallback
 *
 * Returns null when no user key is available (caller falls through to
 * platform env vars or gateway).
 */
export async function resolveByokApiKey(
  ctx: KeyLookupCtx,
  ownerId: string,
  provider: string,
): Promise<ByokKeyResult | null> {
  // 1. Direct provider key
  const secretKey = getProviderSecretKey(provider);
  if (secretKey) {
    const key = await getUserProviderKey(ctx, ownerId, secretKey);
    if (key) return { apiKey: key, source: "direct" };
  }

  // 2. OpenRouter fallback
  const openrouterKey = await getUserProviderKey(ctx, ownerId, "llm:openrouter");
  if (openrouterKey) return { apiKey: openrouterKey, source: "openrouter" };

  return null;
}

/**
 * Map provider name to environment variable name for platform-level keys.
 * Used by the transparent LLM proxy when no user BYOK key is available.
 */
export const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  azure: "AZURE_API_KEY",
  "azure-cognitive-services": "AZURE_COGNITIVE_SERVICES_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_TOKEN",
  vercel: "AI_GATEWAY_API_KEY",
  zenmux: "ZENMUX_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  kilo: "KILO_API_KEY",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
  gitlab: "GITLAB_TOKEN",
  "github-copilot": "GITHUB_TOKEN",
  "github-copilot-enterprise": "GITHUB_TOKEN",
  "sap-ai-core": "AICORE_SERVICE_KEY",
  opencode: "OPENCODE_API_KEY",
  inception: "INCEPTION_API_KEY",
};

/**
 * Resolve a platform-level API key from environment variables.
 * Returns null if no key is configured for the provider.
 */
export function resolvePlatformApiKey(provider: string): string | null {
  const envKey = PROVIDER_ENV_KEY_MAP[provider];
  if (envKey) {
    const value = process.env[envKey];
    if (value) return value;
  }
  // Special case: Google Vertex uses different env vars
  if (provider === "google-vertex" || provider === "google-vertex-anthropic") {
    return (
      process.env.GOOGLE_VERTEX_ACCESS_TOKEN?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim() ||
      null
    );
  }
  return null;
}
