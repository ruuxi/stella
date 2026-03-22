import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../../../packages/ai/providers/openai-codex-responses.js";
import type { Context, Model } from "../../../packages/ai/types.js";

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

function buildSsePayload({
	status,
	includeDone = false,
}: {
	status: "completed" | "incomplete";
	includeDone?: boolean;
}): string {
	const terminalType = status === "incomplete" ? "response.incomplete" : "response.completed";
	const events = [
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", content: [], status: "in_progress" },
		})}`,
		`data: ${JSON.stringify({
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: "hello",
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [{ type: "output_text", text: "hello", annotations: [] }],
				status: "completed",
			},
		})}`,
		`data: ${JSON.stringify({
			type: terminalType,
			response: {
				status,
				incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
				usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 },
			},
		})}`,
	];

	if (includeDone) {
		events.push("data: [DONE]");
	}

	return `${events.join("\n\n")}\n\n`;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("openai codex SSE parsing", () => {
	it("parses LF-delimited events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeSseResponse([
					'data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}\n\n',
					'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
					'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}\n\n',
					'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}],"status":"completed"}}\n\n',
					'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":5,"total_tokens":8}}}\n\n',
				]),
			),
		);

		const stream = streamOpenAICodexResponses(model, context, { apiKey });
		const result = await stream.result();
		const textPart = result.content.find((item) => item.type === "text");

		expect(result.stopReason).toBe("stop");
		expect(textPart).toMatchObject({ type: "text", text: "hello" });
		expect(result.usage.totalTokens).toBe(8);
	});

	it("completes after response.completed even when the SSE body stays open", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(buildSsePayload({ status: "completed", includeDone: true })));
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
			),
		);

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for completed SSE stream")), 1000);
			}),
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((item) => item.type === "text")).toMatchObject({
			type: "text",
			text: "hello",
		});
		expect(result.usage.totalTokens).toBe(6);
	});

	it("maps response.incomplete to stopReason length even when the SSE body stays open", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(buildSsePayload({ status: "incomplete" })));
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
			),
		);

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for incomplete SSE stream")), 1000);
			}),
		]);

		expect(result.stopReason).toBe("length");
		expect(result.content.find((item) => item.type === "text")).toMatchObject({
			type: "text",
			text: "hello",
		});
		expect(result.usage.totalTokens).toBe(6);
	});
});
