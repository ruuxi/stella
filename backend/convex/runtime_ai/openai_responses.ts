import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { AssistantMessageEventStream } from "./event_stream";
import { headersToRecord } from "./headers";
import { supportsXhigh } from "./model_utils";
import {
  convertResponsesMessages,
  convertResponsesTools,
  normalizeOpenAIFunctionName,
  processResponsesStream,
} from "./openai_responses_shared";
import { buildBaseOptions, clampReasoning } from "./simple_options";
import type {
  Api,
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "./types";

const OPENAI_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
]);

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function summarizeOpenAIError(error: unknown): Record<string, unknown> {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : {};
  const headers = record.headers ?? record.responseHeaders;
  const requestId =
    typeof record.request_id === "string"
      ? record.request_id
      : typeof record.requestID === "string"
        ? record.requestID
        : readHeader(headers, "x-request-id");

  return {
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    status: typeof record.status === "number" ? record.status : undefined,
    code:
      typeof record.code === "string"
        ? record.code
        : typeof nested.code === "string"
          ? nested.code
          : undefined,
    type:
      typeof record.type === "string"
        ? record.type
        : typeof nested.type === "string"
          ? nested.type
          : undefined,
    param:
      typeof record.param === "string"
        ? record.param
        : typeof nested.param === "string"
          ? nested.param
          : undefined,
    requestId,
  };
}

function resolveCacheRetention(
  cacheRetention?: CacheRetention,
): CacheRetention {
  return cacheRetention || "short";
}

function getPromptCacheRetention(
  baseUrl: string,
  cacheRetention: CacheRetention,
): "24h" | undefined {
  return cacheRetention === "long" && baseUrl.includes("api.openai.com")
    ? "24h"
    : undefined;
}

export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string }
    | { type: "function"; function: { name: string } };
  responseFormat?: unknown;
}

function normalizeResponsesToolChoice(
  toolChoice: OpenAIResponsesOptions["toolChoice"],
):
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string }
  | undefined {
  if (!toolChoice || typeof toolChoice === "string") {
    return toolChoice;
  }
  const record = toolChoice as Record<string, unknown>;
  const directName = typeof record.name === "string" ? record.name : "";
  if (directName.length > 0) {
    return { type: "function", name: normalizeOpenAIFunctionName(directName) };
  }
  const nested = record.function as Record<string, unknown> | undefined;
  const nestedName =
    nested && typeof nested.name === "string" ? nested.name : "";
  if (nestedName.length > 0) {
    return { type: "function", name: normalizeOpenAIFunctionName(nestedName) };
  }
  return undefined;
}

export const streamOpenAIResponses: StreamFunction<
  "openai-responses",
  OpenAIResponsesOptions
> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId =
        cacheRetention === "none" ? undefined : options?.sessionId;
      const client = createClient(
        model,
        options?.apiKey,
        options?.headers,
        cacheSessionId,
      );
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as typeof params;
      }

      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        ...(options?.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
      };
      const { data: openaiStream, response } = await client.responses
        .create(params, requestOptions)
        .withResponse();
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      await processResponsesStream(openaiStream, output, stream, model, {
        serviceTier: options?.serviceTier,
        applyServiceTierPricing,
      });

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(
          output.errorMessage || "Provider returned an error stop reason",
        );
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      console.error("[openai-responses] request failed", {
        provider: model.provider,
        model: model.id,
        baseUrl: model.baseUrl,
        ...summarizeOpenAIError(error),
      });
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (model, context, options) => {
  const base = buildBaseOptions(model, options, options?.apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  const toolChoice = (options as OpenAIResponsesOptions | undefined)
    ?.toolChoice;
  const responseFormat = (options as OpenAIResponsesOptions | undefined)
    ?.responseFormat;
  const reasoningSummary = reasoningEffort
    ? ((options as OpenAIResponsesOptions | undefined)?.reasoningSummary ??
      "detailed")
    : (options as OpenAIResponsesOptions | undefined)?.reasoningSummary;

  return streamOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
    reasoningSummary,
    toolChoice,
    responseFormat,
  });
};

function createClient(
  model: Model<"openai-responses">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const compat = model.compat ?? {};
  const defaultHeaders: Record<string, string> = {
    ...model.headers,
    ...optionsHeaders,
  };
  if (sessionId && compat.sendSessionIdHeader) {
    defaultHeaders.session_id = sessionId;
  }

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    maxRetries: 0,
    defaultHeaders,
  });
}

function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): ResponseCreateParamsStreaming {
  const messages = convertResponsesMessages(
    model,
    context,
    OPENAI_TOOL_CALL_PROVIDERS,
  );
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);

  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key:
      cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention:
      model.compat?.supportsLongCacheRetention === false
        ? undefined
        : getPromptCacheRetention(model.baseUrl, cacheRetention),
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }

  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      params.reasoning = {
        effort: options?.reasoningEffort || "medium",
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.id.startsWith("gpt-5")) {
      messages.push({
        role: "developer",
        content: [{ type: "input_text", text: "# Juice: 0 !important" }],
      });
    }
  }

  Object.assign(
    params as unknown as Record<string, unknown>,
    options?.extraBody ?? {},
  );

  const toolChoice = normalizeResponsesToolChoice(options?.toolChoice);
  if (toolChoice !== undefined) {
    (params as unknown as Record<string, unknown>).tool_choice = toolChoice;
  }

  if (options?.responseFormat !== undefined) {
    (params as unknown as Record<string, unknown>).response_format =
      options.responseFormat;
  }

  return params;
}

function getServiceTierCostMultiplier(
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
) {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
}
