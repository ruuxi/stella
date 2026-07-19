import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamAnthropic } from "../../../../runtime/ai/providers/anthropic.js";
import { streamGoogle } from "../../../../runtime/ai/providers/google.js";
import { streamGoogleGeminiCli } from "../../../../runtime/ai/providers/google-gemini-cli.js";
import type { AssistantMessageEvent, Context, Model } from "../../../../runtime/ai/types.js";
import { anomalousStreamStopError, providerAbortedStopMessage } from "../../../../runtime/ai/utils/provider-stop.js";
import { classifyAgentRunFailure } from "../../../../runtime/kernel/agent-runtime/agent-run-retry.js";
import { isProviderContentAbortMessage } from "../../../../runtime/kernel/agent-runtime/provider-abort-containment.js";

/**
 * Layer-1 regression tests for the "An unknown error occurred" swallow:
 * a provider-side refusal/safety stop must surface the raw stop reason in
 * the terminal error instead of an opaque generic message.
 */

const model: Model<"anthropic-messages"> = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 128_000,
	contextWindow: 200_000,
};

const context: Context = {
	systemPrompt: "you are a test",
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
	tools: [],
};

/** Fake Anthropic SDK client that streams SSE events we push manually. */
function makeFakeClient() {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const encoder = new TextEncoder();

	const create = (_body: unknown, _opts?: { signal?: AbortSignal }) => ({
		asResponse: async () => {
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
	});

	const client = { messages: { create } } as unknown as Anthropic;
	const push = (event: string, data: unknown) => {
		controller?.enqueue(
			encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
		);
	};
	const close = () => controller?.close();
	return { client, push, close };
}

const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

describe("provider abort reason surfacing (anthropic)", () => {
	it("surfaces the raw refusal stop reason instead of an opaque unknown error", async () => {
		const { client, push, close } = makeFakeClient();
		const events: AssistantMessageEvent[] = [];

		const stream = streamAnthropic(model, context, { client });
		const done = (async () => {
			for await (const event of stream) events.push(event);
		})();

		await tick();
		push("message_start", {
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 1,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		});
		push("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "refusal" },
			usage: { output_tokens: 1 },
		});
		push("message_stop", { type: "message_stop" });
		await tick();
		close();
		await done;

		const error = events.find((event) => event.type === "error") as
			| Extract<AssistantMessageEvent, { type: "error" }>
			| undefined;
		expect(error).toBeDefined();
		expect(error!.reason).toBe("error");
		expect(error!.error.errorMessage).toContain('stop reason: "refusal"');
		expect(error!.error.errorMessage).toMatch(/refusal\/safety\/content-filter/i);
		expect(error!.error.errorMessage).not.toBe("An unknown error occurred");
	});
});

describe("provider abort reason surfacing (google-gemini-cli)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("captures the raw SAFETY finish reason from the Cloud Code Assist stream", async () => {
		const encoder = new TextEncoder();
		const sse = [
			`data: ${JSON.stringify({
				response: {
					candidates: [
						{
							content: { parts: [{ text: "partial reply before the filter" }] },
							finishReason: "SAFETY",
						},
					],
					usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
				},
			})}`,
			"",
			"",
		].join("\n");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(encoder.encode(sse), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			),
		);

		const geminiModel: Model<"google-gemini-cli"> = {
			...(model as unknown as Model<"google-gemini-cli">),
			id: "gemini-3-pro",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode.example",
		};
		const stream = streamGoogleGeminiCli(geminiModel, context, {
			apiKey: JSON.stringify({ token: "test-token", projectId: "proj" }),
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		const error = events.find((event) => event.type === "error") as
			| Extract<AssistantMessageEvent, { type: "error" }>
			| undefined;
		expect(error).toBeDefined();
		expect(error!.error.errorMessage).toContain('stop reason: "SAFETY"');
		expect(error!.error.errorMessage).toMatch(/refusal\/safety\/content-filter/i);
	});
});

describe("provider-stop helpers", () => {
	it("providerAbortedStopMessage uses safety wording for safety-class stop reasons", () => {
		const message = providerAbortedStopMessage("sensitive");
		expect(message).toContain('stop reason: "sensitive"');
		expect(message).toMatch(/refusal\/safety\/content-filter/i);
		expect(providerAbortedStopMessage("PROHIBITED_CONTENT")).toMatch(
			/refusal\/safety\/content-filter/i,
		);
	});

	it("providerAbortedStopMessage stays neutral for non-safety terminal stops", () => {
		for (const raw of ["cancelled", "failed", "OTHER", "network_error"]) {
			const message = providerAbortedStopMessage(raw);
			expect(message).toContain(`stop reason: "${raw}"`);
			expect(message).not.toMatch(/refusal\/safety\/content-filter/i);
			expect(message).toMatch(/ended the stream abnormally/i);
		}
	});

	it("anomalousStreamStopError prefers captured detail over the fallback", () => {
		const withDetail = anomalousStreamStopError({
			stopReason: "error",
			errorMessage: "HTTP 400: upstream said no",
		});
		expect(withDetail.message).toBe("HTTP 400: upstream said no");

		const withoutDetail = anomalousStreamStopError({ stopReason: "error" });
		expect(withoutDetail.message).toContain('stopReason "error"');
		expect(withoutDetail.message).not.toBe("An unknown error occurred");
	});
});

describe("google prompt-block surfacing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("surfaces promptFeedback.blockReason from the Gemini API stream as a content abort", async () => {
		const encoder = new TextEncoder();
		const sse = `data: ${JSON.stringify({
			promptFeedback: {
				blockReason: "PROHIBITED_CONTENT",
				blockReasonMessage: "blocked by policy",
			},
		})}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(encoder.encode(sse), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			),
		);

		const googleModel: Model<"google-generative-ai"> = {
			...(model as unknown as Model<"google-generative-ai">),
			id: "gemini-3-pro",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://gemini.test/v1beta",
		};
		const result = await streamGoogle(googleModel, context, {
			apiKey: "test-key",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('block reason: "PROHIBITED_CONTENT"');
		expect(result.errorMessage).toContain("blocked by policy");
		expect(isProviderContentAbortMessage(result.errorMessage)).toBe(true);
		expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toMatchObject({
			category: "non_retryable",
			retryable: false,
		});
	});

	it("surfaces promptFeedback.blockReason from Cloud Code Assist without empty-stream retries", async () => {
		const encoder = new TextEncoder();
		const sse = [
			`data: ${JSON.stringify({
				response: {
					promptFeedback: { blockReason: "SAFETY" },
				},
			})}`,
			"",
			"",
		].join("\n");
		const fetchMock = vi.fn(async () =>
			new Response(encoder.encode(sse), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const geminiModel: Model<"google-gemini-cli"> = {
			...(model as unknown as Model<"google-gemini-cli">),
			id: "gemini-3-pro",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode.example",
		};
		const result = await streamGoogleGeminiCli(geminiModel, context, {
			apiKey: JSON.stringify({ token: "test-token", projectId: "proj" }),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('block reason: "SAFETY"');
		expect(isProviderContentAbortMessage(result.errorMessage)).toBe(true);
		// A blocked prompt is deterministic: it must not burn empty-stream
		// retries replaying the same blocked request.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
