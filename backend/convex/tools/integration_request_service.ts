import { getUnsafeIntegrationHostError } from "./network_safety";

export type IntegrationRequestLike = {
  provider: string;
  mode?: "public" | "private";
  secretId?: string;
  publicKeyEnv?: string;
  request: {
    url: string;
  };
};

export type PublicIntegrationPolicy = {
  envVar: string;
  allowedHosts: string[];
};

type SecretRecord = {
  secretId: string;
  provider: string;
  label: string;
  plaintext: string;
  status: string;
  metadata?: unknown;
};

export const executeIntegrationRequestService = async <TArgs extends IntegrationRequestLike>(args: {
  request: TArgs;
  wrapExternalContent: (content: string, source: string) => string;
  readEnv: (name: string) => string | undefined;
  hostAllowed: (hostname: string, allowedHosts: string[]) => boolean;
  deriveHostPatterns: (hostname: string) => string[];
  providersCompatible: (requestedProvider: string, secretProvider: string) => boolean;
  runIntegrationRequest: (
    request: TArgs,
    key?: string,
    options?: { allowPrivateNetworkHosts?: boolean },
  ) => Promise<string>;
  lookupPublicPolicy: (provider: string) => Promise<PublicIntegrationPolicy | null>;
  lookupPrivateAllowedHosts: (providerKey: string, secretId: string) => Promise<string[]>;
  persistPrivateAllowedHosts: (
    providerKey: string,
    secretId: string,
    hosts: string[],
  ) => Promise<void>;
  requireOwnerContextError: () => string | null;
  withSecret: (
    secretId: string,
    handler: (secret: SecretRecord) => Promise<string>,
  ) => Promise<string>;
}) => {
  const mode =
    args.request.mode ??
    (args.request.secretId
      ? "private"
      : args.request.publicKeyEnv
        ? "public"
        : "private");

  let requestUrl: URL;
  try {
    requestUrl = new URL(args.request.request.url);
  } catch {
    return "IntegrationRequest requires a valid URL.";
  }
  if (!["http:", "https:"].includes(requestUrl.protocol)) {
    return "IntegrationRequest only supports http(s) URLs.";
  }

  const unsafeHostError = getUnsafeIntegrationHostError(requestUrl, {
    allowPrivateNetworkHosts: mode === "private",
  });
  if (unsafeHostError) {
    return unsafeHostError;
  }

  const providerKey = args.request.provider.trim().toLowerCase();

  if (mode === "public") {
    const policy = await args.lookupPublicPolicy(args.request.provider);
    if (!policy) {
      return `Public integration policy is not configured for provider "${args.request.provider}". Configure STELLA_PUBLIC_INTEGRATION_RULES env var or add a row to integrations_public.`;
    }

    const requestedEnvName = args.request.publicKeyEnv?.trim();
    if (
      requestedEnvName &&
      requestedEnvName.length > 0 &&
      requestedEnvName !== policy.envVar
    ) {
      return `publicKeyEnv does not match the configured env for provider "${args.request.provider}".`;
    }

    if (!args.hostAllowed(requestUrl.hostname, policy.allowedHosts)) {
      return `Public integration host "${requestUrl.hostname}" is not allowed for provider "${args.request.provider}".`;
    }

    const key = args.readEnv(policy.envVar);
    if (!key) {
      return `Public integration is missing env var: ${policy.envVar}.`;
    }

    const publicResult = await args.runIntegrationRequest(args.request, key, {
      allowPrivateNetworkHosts: false,
    });
    if (publicResult.startsWith("IntegrationRequest")) {
      return publicResult;
    }
    return args.wrapExternalContent(publicResult, args.request.request.url);
  }

  if (!args.request.secretId) {
    return "IntegrationRequest requires secretId when mode is private.";
  }
  const ownerCheck = args.requireOwnerContextError();
  if (ownerCheck) {
    return ownerCheck;
  }

  const secretId = String(args.request.secretId);
  const privateResult = await args.withSecret(secretId, async (secret) => {
    if (!args.providersCompatible(args.request.provider, secret.provider)) {
      return `IntegrationRequest provider "${args.request.provider}" is not compatible with secret provider "${secret.provider}".`;
    }

    let allowedHosts = await args.lookupPrivateAllowedHosts(
      providerKey,
      String(secret.secretId),
    );

    if (allowedHosts.length === 0) {
      allowedHosts = args.deriveHostPatterns(requestUrl.hostname);
      if (allowedHosts.length > 0) {
        await args.persistPrivateAllowedHosts(
          providerKey,
          String(secret.secretId),
          allowedHosts,
        );
      }
    }

    if (
      allowedHosts.length > 0 &&
      !args.hostAllowed(requestUrl.hostname, allowedHosts)
    ) {
      return `Private integration host "${requestUrl.hostname}" is not allowed for provider "${args.request.provider}". Allowed hosts: ${allowedHosts.join(", ")}.`;
    }

    return args.runIntegrationRequest(args.request, secret.plaintext, {
      allowPrivateNetworkHosts: true,
    });
  });

  if (
    privateResult.startsWith("Secret access failed") ||
    privateResult.startsWith("IntegrationRequest")
  ) {
    return privateResult;
  }
  return args.wrapExternalContent(privateResult, args.request.request.url);
};
