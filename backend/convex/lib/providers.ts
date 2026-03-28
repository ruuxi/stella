/**
 * Backend-local provider registry for model resolution and BYOK lookup.
 */

export type SdkType = "anthropic" | "openai" | "amazon-bedrock" | "google" | "gitlab" | "baseten";

/**
 * Maps provider strings to their AI SDK constructor type.
 * The default/fallback for unknown providers is "openai" (OpenAI-compatible).
 */
export const PROVIDER_SDK_MAP: Record<string, SdkType> = {
  // Anthropic-compatible
  anthropic: "anthropic",
  zenmux: "anthropic",

  // OpenAI-compatible
  openai: "openai",
  openrouter: "openai",
  azure: "openai",
  "azure-cognitive-services": "openai",
  "cloudflare-workers-ai": "openai",
  "cloudflare-ai-gateway": "openai",
  "google-vertex": "openai",
  "google-vertex-anthropic": "openai",
  vercel: "openai",
  cerebras: "openai",
  kilo: "openai",
  "sap-ai-core": "openai",
  "github-copilot": "openai",
  "github-copilot-enterprise": "openai",
  opencode: "openai",
  moonshotai: "openai",
  zai: "openai",
  inception: "openai",
  fireworks: "openai",

  // Baseten (native SDK)
  baseten: "baseten",

  // Native SDKs
  "amazon-bedrock": "amazon-bedrock",
  google: "google",
  gitlab: "gitlab",
};

/**
 * Providers that require Node.js runtime and cannot run in Convex's V8 environment.
 * The backend returns null for these and falls through to the BYOK chain (OpenRouter/gateway).
 * The frontend handles them via the LLM proxy.
 */
export const NODE_ONLY_PROVIDERS = new Set([
  "amazon-bedrock",
  "google-vertex",
  "google-vertex-anthropic",
  "gitlab",
  "sap-ai-core",
  "baseten",
]);

/**
 * All known provider strings. Union of all keys in PROVIDER_SDK_MAP.
 */
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_SDK_MAP);

/**
 * Maps provider strings to their secrets key format for BYOK resolution.
 */
export const PROVIDER_SECRET_KEYS: Record<string, string> = {
  anthropic: "llm:anthropic",
  openai: "llm:openai",
  google: "llm:google",
  azure: "llm:azure",
  "azure-cognitive-services": "llm:azure-cognitive-services",
  "cloudflare-workers-ai": "llm:cloudflare-workers-ai",
  vercel: "llm:vercel",
  zenmux: "llm:zenmux",
  cerebras: "llm:cerebras",
  kilo: "llm:kilo",
  "amazon-bedrock": "llm:amazon-bedrock",
  "google-vertex": "llm:google-vertex",
  "google-vertex-anthropic": "llm:google-vertex-anthropic",
  "cloudflare-ai-gateway": "llm:cloudflare-ai-gateway",
  gitlab: "llm:gitlab",
  "github-copilot": "llm:github-copilot",
  "github-copilot-enterprise": "llm:github-copilot-enterprise",
  "sap-ai-core": "llm:sap-ai-core",
  opencode: "llm:opencode",
  inception: "llm:inception",
  baseten: "llm:baseten",
  fireworks: "llm:fireworks",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract provider prefix from a model string like "anthropic/claude-opus-4.6" */
export function extractProvider(modelString: string): string | null {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return null;
  return modelString.slice(0, slash);
}

/** Extract model name after provider prefix */
export function extractModelName(modelString: string): string {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return modelString;
  return modelString.slice(slash + 1);
}

/** Get the SDK type for a given provider string. Defaults to "openai" for unknown providers. */
export function getSdkType(provider: string): SdkType {
  return PROVIDER_SDK_MAP[provider] ?? "openai";
}

/** Check if a provider requires Node.js and can't run in Convex V8. */
export function isNodeOnlyProvider(provider: string): boolean {
  return NODE_ONLY_PROVIDERS.has(provider);
}

/** Get the secrets key for a provider, or null if unknown. */
export function getProviderSecretKey(provider: string): string | null {
  return PROVIDER_SECRET_KEYS[provider] ?? null;
}
