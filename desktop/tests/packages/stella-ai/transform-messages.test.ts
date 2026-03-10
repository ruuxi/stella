import { describe, expect, it, vi } from "vitest";
import { transformMessages } from "../../../electron/core/ai/providers/transform-messages.js";
import type { AssistantMessage, Model } from "../../../electron/core/ai/types.js";

const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 128000,
	maxTokens: 4096,
};

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		content: [
			{ type: "text", text: "Checking that now." },
			{ type: "toolCall", id: "call_123", name: "lookupWeather", arguments: { city: "Phoenix" } },
		],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("transformMessages", () => {
	it("flushes synthetic tool results for orphaned tool calls at end of history", () => {
		vi.spyOn(Date, "now").mockReturnValue(1234);

		const transformed = transformMessages([createAssistantMessage()], model);

		expect(transformed).toHaveLength(2);
		expect(transformed[1]).toEqual({
			role: "toolResult",
			toolCallId: "call_123",
			toolName: "lookupWeather",
			content: [{ type: "text", text: "No result provided" }],
			isError: true,
			timestamp: 1234,
		});
	});
});
