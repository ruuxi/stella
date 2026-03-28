export const MANAGED_GATEWAY_PROVIDERS = [
  "openrouter",
  "fireworks",
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
};

const FIREWORKS_MODEL_PREFIXES = [
  "accounts/fireworks/models/",
  "accounts/fireworks/routers/",
] as const;

export function getManagedGatewayConfig(
  provider: ManagedGatewayProvider = "openrouter",
): ManagedGatewayConfig {
  return MANAGED_GATEWAY_CONFIGS[provider];
}

export function inferManagedGatewayProviderFromModel(
  model: string,
): ManagedGatewayProvider | undefined {
  return FIREWORKS_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? "fireworks"
    : undefined;
}

export function resolveManagedGatewayProvider(args: {
  model: string;
  configuredProvider?: ManagedGatewayProvider;
}): ManagedGatewayProvider {
  return inferManagedGatewayProviderFromModel(args.model)
    ?? args.configuredProvider
    ?? "openrouter";
}

export function resolveManagedGatewayConfig(args: {
  model: string;
  configuredProvider?: ManagedGatewayProvider;
}): ManagedGatewayConfig {
  return getManagedGatewayConfig(resolveManagedGatewayProvider(args));
}
