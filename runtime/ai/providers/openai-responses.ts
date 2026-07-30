import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../models.js";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { splitDeferredTools } from "../utils/deferred-tools.js";
import { anomalousStreamStopError } from "../utils/provider-stop.js";
import { resilientEventStream } from "../utils/resilient-event-stream.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const STELLA_RELAY_RESUME_HEADER = "x-stella-relay-resume";
const STELLA_RELAY_REQUEST_ID_HEADER = "x-stella-relay-request-id";
const STELLA_RELAY_RESUME_VERSION = "1";

const isManagedStellaRelayBaseUrl = (baseUrl: string): boolean => {
	try {
		return new URL(baseUrl).pathname.replace(/\/+$/u, "").endsWith("/api/stella/relay");
	} catch {
		return false;
	}
};

const newRelayRequestId = (): string =>
	`stella-relay-${
		globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	}`;

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsToolSearch:
			model.compat?.supportsToolSearch ??
			(model.provider === "openai" && /^gpt-(?:[6-9]|\d{2,})|^gpt-5\.[4-9]/.test(model.id)),
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		let detachRelayAbortListener = () => {};
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
			stopReason: "error",
			timestamp: Date.now(),
		};

		try {
			// Create OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			// Keep SDK retries out of this path: they do not cover body-stream
			// closures and their independent deadline can exceed Stella's bounded
			// reconnect window. The resilience wrapper below owns both phases.
			const idempotencyKey = `stella-response-${
				globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
			}`;
			const proposedRelayRequestId = isManagedStellaRelayBaseUrl(model.baseUrl) ? newRelayRequestId() : undefined;
			const requestOptions = (signal?: AbortSignal, initializeRelay = false) => ({
				...(signal ? { signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
				headers: {
					"Idempotency-Key": idempotencyKey,
					...(initializeRelay && proposedRelayRequestId
						? { [STELLA_RELAY_REQUEST_ID_HEADER]: proposedRelayRequestId }
						: {}),
				},
			});
			let relayRequestId = proposedRelayRequestId;
			let relayResumeCapable = false;
			let relayAbortListenerAttached = false;
			const providerDurableResumeEnabled = params.background === true && params.store !== false;
			const attachRelayAbortListener = (requestId: string) => {
				if (!options?.signal || relayAbortListenerAttached) return;
				relayAbortListenerAttached = true;
				const cancelRelayResponse = () => {
					void (async () => {
						for (const delayMs of [0, 100, 250, 500, 1_000]) {
							if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
							try {
								await client.delete<void>(`/responses/${encodeURIComponent(requestId)}`, {
									maxRetries: 0,
									timeout: options.timeoutMs ?? 10_000,
								});
								return;
							} catch (error) {
								if ((error as { status?: unknown })?.status !== 404) return;
							}
						}
					})();
				};
				if (options.signal.aborted) cancelRelayResponse();
				else options.signal.addEventListener("abort", cancelRelayResponse, { once: true });
				detachRelayAbortListener = () => options.signal?.removeEventListener("abort", cancelRelayResponse);
			};
			if (proposedRelayRequestId) attachRelayAbortListener(proposedRelayRequestId);
			const noteResponse = async (response: Response): Promise<void> => {
				const headers = headersToRecord(response.headers);
				const advertisedVersion = response.headers.get(STELLA_RELAY_RESUME_HEADER)?.trim();
				const advertisedRequestId = response.headers.get(STELLA_RELAY_REQUEST_ID_HEADER)?.trim();
				if (advertisedVersion === STELLA_RELAY_RESUME_VERSION && advertisedRequestId) {
					if (proposedRelayRequestId && advertisedRequestId !== proposedRelayRequestId) {
						throw new Error("Stella relay returned a mismatched resume request id");
					}
					relayResumeCapable = true;
					relayRequestId = advertisedRequestId;
					attachRelayAbortListener(advertisedRequestId);
				}
				await options?.onResponse?.({ status: response.status, headers }, model);
			};
			const connect = async (signal?: AbortSignal): Promise<AsyncIterable<ResponseStreamEvent>> => {
				const { data, response } = await client.responses
					.create(params, requestOptions(signal, true))
					.withResponse();
				await noteResponse(response);
				return data;
			};
			const resume = async ({ runId, cursor, signal }: { runId: string; cursor: number; signal?: AbortSignal }) => {
				const { data, response } = await client.responses
					.retrieve(runId, { stream: true, starting_after: cursor }, requestOptions(signal))
					.withResponse();
				await noteResponse(response);
				return data;
			};
			const openaiStream = resilientEventStream<ResponseStreamEvent>({
				connect,
				resume,
				// A managed relay client proposes the id before POST. Seed cursor 0
				// even if an older backend omits capability headers: GET may fail
				// closed, but the original POST is never replayed. New backends return
				// the same id and serve the durable cursor.
				getInitialResumeState: () =>
					proposedRelayRequestId
						? { runId: proposedRelayRequestId, cursor: 0 }
						: relayResumeCapable && relayRequestId
							? { runId: relayRequestId, cursor: 0 }
							: undefined,
				getRunId: (event) => {
					if (relayResumeCapable) return relayRequestId;
					return providerDurableResumeEnabled && "response" in event && event.response?.id
						? event.response.id
						: undefined;
				},
				getSequence: (event) => {
					const relaySequence = (event as ResponseStreamEvent & { stella_relay_sequence?: unknown })
						.stella_relay_sequence;
					if (relayResumeCapable) {
						return typeof relaySequence === "number" ? relaySequence : undefined;
					}
					return typeof event.sequence_number === "number" ? event.sequence_number : undefined;
				},
				isTerminal: (event) =>
					event.type === "response.completed" ||
					event.type === "response.incomplete" ||
					event.type === "response.failed" ||
					event.type === "error",
				...(options?.signal ? { signal: options.signal } : {}),
				onReconnect: ({ attempt, delayMs, reason }) => options?.onProviderRetry?.({ attempt, delayMs, reason }),
			});
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw anomalousStreamStopError(output);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			detachRelayAbortListener();
			stream.end();
		} catch (error) {
			detachRelayAbortListener();
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// The OpenAI SDK requires a non-empty apiKey even when authentication is
	// supplied entirely by custom headers. Match the completions transport's
	// local/custom-base-url sentinel; model/options headers still override the
	// SDK's generated Authorization header.
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || (model.baseUrl ? "local" : undefined);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	const compat = getCompat(model);
	const headers = { ...model.headers };
	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
		headers["HTTP-Referer"] ??= "https://stella.sh";
		headers["X-OpenRouter-Title"] ??= "Stella";
	}
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sendSessionIdHeader) {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	const defaultHeaders =
		model.provider === "cloudflare-ai-gateway"
			? {
					...headers,
					Authorization: headers.Authorization ?? null,
					"cf-aig-authorization": `Bearer ${apiKey}`,
				}
			: headers;

	return new OpenAI({
		apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const compat = getCompat(model);
	const toolPlacement = splitDeferredTools(context, compat.supportsToolSearch);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		deferredTools: toolPlacement.deferred,
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		params.tools = convertResponsesTools(toolPlacement.immediate);
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
