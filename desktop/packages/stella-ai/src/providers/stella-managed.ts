import { buildBaseOptions } from "./simple-options.js";
import { convertMessages, convertTools, hasToolHistory } from "./openai-completions.js";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	OpenAICompletionsCompat,
	SimpleStreamOptions,
	StellaManagedCompat,
	StreamFunction,
	StreamOptions,
	TextContent,
} from "../types.js";
import {
	createAssistantMessageShell,
	pumpOpenAICompatibleChatCompletionsResponse,
} from "../utils/openai-completions-sse.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";

const DEFAULT_CONTEXT_WINDOW = 256_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_MODEL_NAME = "Stella Managed";
const DEFAULT_MODEL_ID = "stella-managed";

const MANAGED_COMPAT: Required<OpenAICompletionsCompat> = {
	supportsStore: false,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	supportsStrictMode: false,
};

const createEmptyUsage = (): AssistantMessage["usage"] => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
});

export interface ManagedModel extends Model<"stella-managed"> {
	compat: StellaManagedCompat;
}

export type ManagedChatMessage = {
	role: "system" | "developer" | "user" | "assistant";
	content: string | Array<{ type?: string; text?: string }>;
};

export function createManagedModel(args: {
	endpoint: string;
	agentType: string;
	headers?: Record<string, string>;
	contextWindow?: number;
	maxTokens?: number;
	id?: string;
	name?: string;
}): ManagedModel {
	return {
		id: args.id ?? `${DEFAULT_MODEL_ID}/${args.agentType}`,
		name: args.name ?? DEFAULT_MODEL_NAME,
		api: "stella-managed",
		provider: "stella-managed",
		baseUrl: args.endpoint,
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: args.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
		headers: args.headers,
		compat: {
			agentType: args.agentType,
		},
	};
}

const toTextBlocks = (content: ManagedChatMessage["content"]): TextContent[] => {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}

	return content
		.filter((part): part is { type?: string; text: string } => typeof part?.text === "string")
		.map((part) => ({ type: "text" as const, text: part.text.trim() }))
		.filter((part) => part.text.length > 0);
};

export function createManagedContext(messages: ManagedChatMessage[]): Context {
	const systemParts: string[] = [];
	const llmMessages: Context["messages"] = [];

	for (const message of messages) {
		const blocks = toTextBlocks(message.content);
		if (message.role === "system" || message.role === "developer") {
			const text = blocks.map((block) => block.text).join("\n").trim();
			if (text) {
				systemParts.push(text);
			}
			continue;
		}

		if (blocks.length === 0) {
			continue;
		}

		if (message.role === "user") {
			llmMessages.push({
				role: "user",
				content: blocks,
				timestamp: Date.now(),
			});
			continue;
		}

		llmMessages.push({
			role: "assistant",
			content: blocks,
			timestamp: Date.now(),
			stopReason: "stop",
			usage: createEmptyUsage(),
			api: "stella-managed",
			provider: "stella-managed",
			model: DEFAULT_MODEL_ID,
		});
	}

	return {
		...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
		messages: llmMessages,
	};
}

export function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

type ManagedStreamOptions = StreamOptions & {
	reasoningEffort?: SimpleStreamOptions["reasoning"];
};

function getAgentType(model: ManagedModel): string {
	const agentType = model.compat?.agentType?.trim();
	if (!agentType) {
		throw new Error("Managed model is missing compat.agentType");
	}
	return agentType;
}

function toOpenAICompatModel(model: ManagedModel): Model<"openai-completions"> {
	return {
		...model,
		api: "openai-completions",
		compat: {
			supportsStrictMode: false,
		},
	};
}

function buildRequestBody(
	model: ManagedModel,
	context: Context,
	options: ManagedStreamOptions & { stream: boolean },
): Record<string, unknown> {
	const compatModel = toOpenAICompatModel(model);
	const body: Record<string, unknown> = {
		agentType: getAgentType(model),
		messages: convertMessages(compatModel, context, MANAGED_COMPAT),
		stream: options.stream,
	};

	if (options.maxTokens) {
		body.max_completion_tokens = options.maxTokens;
	}

	if (options.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options.reasoningEffort) {
		body.reasoning_effort = options.reasoningEffort;
	}

	if (context.tools?.length) {
		body.tools = convertTools(context.tools, MANAGED_COMPAT);
	} else if (hasToolHistory(context.messages)) {
		body.tools = [];
	}

	return body;
}

function buildHeaders(model: ManagedModel, options?: StreamOptions): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(model.headers ?? {}),
		...(options?.headers ?? {}),
	};
	const apiKey = options?.apiKey?.trim();
	if (apiKey && !headers.Authorization && !headers.authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const authorization = headers.Authorization ?? headers.authorization;
	if (!authorization?.trim()) {
		throw new Error("Missing managed AI auth token");
	}
	return headers;
}

async function readErrorDetail(response: Response): Promise<string> {
	try {
		const text = await response.text();
		if (!text) {
			return response.statusText || "Request failed";
		}
		try {
			const parsed = JSON.parse(text) as { error?: string };
			return parsed.error || text;
		} catch {
			return text;
		}
	} catch {
		return response.statusText || "Request failed";
	}
}

function streamManaged(
	model: ManagedModel,
	context: Context,
	options?: ManagedStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output = createAssistantMessageShell(model);

		try {
			const response = await fetch(model.baseUrl, {
				method: "POST",
				headers: buildHeaders(model, options),
				body: JSON.stringify(buildRequestBody(model, context, {
					...options,
					stream: true,
				})),
				signal: options?.signal,
			});

			if (!response.ok) {
				throw new Error(`Managed AI request failed (${response.status}): ${await readErrorDetail(response)}`);
			}

			await pumpOpenAICompatibleChatCompletionsResponse({
				response,
				stream,
				output,
				signal: options?.signal,
			});
		} catch (error) {
			const reason = options?.signal?.aborted ? "aborted" : "error";
			const failure = createAssistantMessageShell(model);
			failure.stopReason = reason;
			failure.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason,
				error: failure,
			});
		}
	})();

	return stream;
}

export const streamStellaManaged: StreamFunction<"stella-managed", StreamOptions> = (
	model,
	context,
	options,
) => streamManaged(model as ManagedModel, context, options);

export const streamSimpleStellaManaged: StreamFunction<"stella-managed", SimpleStreamOptions> = (
	model,
	context,
	options,
) =>
	streamManaged(model as ManagedModel, context, {
		...buildBaseOptions(model, options, options?.apiKey),
		reasoningEffort: options?.reasoning,
	});
