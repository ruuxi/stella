export const MANAGED_GATEWAY_PROVIDERS = [
  "openrouter",
  "fireworks",
  "openai",
  "anthropic",
  "google",
] as const;

export type ManagedGatewayProvider = (typeof MANAGED_GATEWAY_PROVIDERS)[number];

export type ManagedGatewayConfig = {
  provider: ManagedGatewayProvider;
  baseURL: string;
  apiKeyEnvVar: string;
};

const MANAGED_GATEWAY_CONFIGS: Record<ManagedGatewayProvider, ManagedGatewayConfig> = {
  openrouter: {
    provider: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
  },
  fireworks: {
    provider: "fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKeyEnvVar: "FIREWORKS_API_KEY",
  },
  openai: {
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  anthropic: {
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
  google: {
    provider: "google",
    baseURL: "https://generativelanguage.googleapis.com",
    apiKeyEnvVar: "GOOGLE_AI_API_KEY",
  },
};

const FIREWORKS_MODEL_PREFIXES = [
  "accounts/fireworks/models/",
  "accounts/fireworks/routers/",
] as const;

const DIRECT_MODEL_PROVIDER_PREFIXES = [
  ["openai/", "openai"],
  ["anthropic/", "anthropic"],
  ["google/", "google"],
] as const;

export function getManagedGatewayConfig(
  provider: ManagedGatewayProvider = "openrouter",
): ManagedGatewayConfig {
  return MANAGED_GATEWAY_CONFIGS[provider];
}

export function inferManagedGatewayProviderFromModel(
  model: string,
): ManagedGatewayProvider | undefined {
  const directProvider = DIRECT_MODEL_PROVIDER_PREFIXES.find(([prefix]) =>
    model.startsWith(prefix)
  )?.[1];
  if (directProvider) {
    return directProvider;
  }
  return FIREWORKS_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? "fireworks"
    : undefined;
}

export function resolveManagedGatewayProvider(args: {
  model: string;
  configuredProvider?: ManagedGatewayProvider;
}): ManagedGatewayProvider {
  return args.configuredProvider
    ?? inferManagedGatewayProviderFromModel(args.model)
    ?? "openrouter";
}

export function resolveManagedGatewayConfig(args: {
  model: string;
  configuredProvider?: ManagedGatewayProvider;
}): ManagedGatewayConfig {
  return getManagedGatewayConfig(resolveManagedGatewayProvider(args));
}
