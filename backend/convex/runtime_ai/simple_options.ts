import type {
  Api,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingLevel,
} from "./types";

export function buildBaseOptions(
  model: Model<Api>,
  options?: SimpleStreamOptions,
  apiKey?: string,
): StreamOptions {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32_000),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    extraBody: options?.extraBody,
  };
}

export function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined {
  return effort === "xhigh" ? "high" : effort;
}
