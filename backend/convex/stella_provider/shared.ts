import type { ManagedGatewayProvider } from "../lib/managed_gateway";
import type {
  ManagedProtocol,
  streamManagedChat,
} from "../runtime_ai/managed";
import type { ModelConfig } from "../agent/model";

export type StellaRequestBody = Record<string, unknown>;

export type ManagedRuntimeRequest = NonNullable<
  Parameters<typeof streamManagedChat>[0]["request"]
>;

export type UpstreamHttpError = {
  status: number;
  message: string;
};

export type ResolvedStellaModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  config: ModelConfig;
};

export type ResolvedManagedServerModelConfig = {
  model: string;
  managedGatewayProvider: ManagedGatewayProvider;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * Input modalities resolved from `billing_model_prices` (synced from
   * models.dev). Forwarded into `ManagedModelConfig.modalitiesInput` so
   * `buildManagedModel` can derive the correct `Model.input` set instead
   * of the previous hardcoded ["text", "image"]. When omitted the
   * downstream layer defaults to ["text"] (text-only).
   */
  modalitiesInput?: ("text" | "image" | "audio" | "video" | "pdf")[];
};

export type AuthorizedStellaRequest = {
  ownerId: string;
  agentType: string;
  requestJson: StellaRequestBody;
  requestedModel: string;
  resolvedModel: string;
  managedApi: ManagedProtocol;
  serverModelConfig: ResolvedManagedServerModelConfig;
  fallbackModelConfig?: ResolvedManagedServerModelConfig;
  anonymousUsageRecord?: import("./billing").AnonymousUsageRecord;
};

export const STELLA_API_BASE_PATH = "/api/stella/v1";
export const STELLA_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/chat/completions`;
export const STELLA_RUNTIME_PATH = `${STELLA_API_BASE_PATH}/runtime`;
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;

export const SSE_HEARTBEAT_INTERVAL_MS = 45_000;
export const SSE_STREAM_OPEN_COMMENT = new TextEncoder().encode(
  ": stella-stream-open\n\n",
);
export const SSE_HEARTBEAT_COMMENT = new TextEncoder().encode(
  ": keepalive\n\n",
);

export const STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS = new Set([
  "model",
  "agentType",
  "messages",
  "stream",
  "tools",
  "temperature",
  "reasoning",
  "max_completion_tokens",
  "max_tokens",
  "maxOutputTokens",
  "reasoning_effort",
  "tool_choice",
  "response_format",
]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function parseRequestJson(
  request: Request,
): Promise<StellaRequestBody | null> {
  try {
    return (await request.json()) as StellaRequestBody;
  } catch {
    return null;
  }
}

export function toUpstreamHttpError(
  error: unknown,
): UpstreamHttpError | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as {
    status?: unknown;
    message?: unknown;
    error?: { message?: unknown };
  };
  const status = typeof record.status === "number" ? record.status : null;
  if (status === null || status < 400 || status >= 500) {
    return null;
  }

  const directMessage =
    typeof record.error?.message === "string"
      ? record.error.message
      : typeof record.message === "string"
        ? record.message.replace(/^\d+\s+/, "")
        : "Invalid Stella completion request";

  return {
    status,
    message: directMessage,
  };
}
