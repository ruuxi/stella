import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../../../packages/stella-ai/src/providers/openai-codex-responses.js";
import type { Context, Model } from "../../../packages/stella-ai/src/types.js";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex-mini",
	name: "GPT-5.1 Codex Mini",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200000,
	maxTokens: 32000,
};

const context: Context = {
	systemPrompt: "You are Stella.",
	messages: [],
};

const apiKey = [
	"header",
	Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct_test",
			},
		}),
	).toString("base64url"),
	"signature",
].join(".");

function makeSseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("openai codex SSE parsing", () => {
	it("parses CRLF-delimited events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeSseResponse([
					'data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}\r\n\r\n',
					'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\r\n\r\n',
					'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}\r\n\r\n',
					'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}],"status":"completed"}}\r\n\r\n',
					'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":5,"total_tokens":8}}}\r\n\r\n',
				]),
			),
		);

		const stream = streamOpenAICodexResponses(model, context, { apiKey });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello", textSignature: "msg_1" }]);
		expect(result.usage.totalTokens).toBe(8);
	});

	it("flushes the final event at EOF without a trailing separator", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeSseResponse([
					'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":4,"total_tokens":6}}}',
				]),
			),
		);

		const stream = streamOpenAICodexResponses(model, context, { apiKey });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(2);
		expect(result.usage.output).toBe(4);
		expect(result.usage.totalTokens).toBe(6);
	});
});
