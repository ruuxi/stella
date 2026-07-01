import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";

import {
	isLatestAssistantThinkingModifiedError,
	stripDanglingThinkingFromLatestAssistant,
	stripThinkingFromLastAssistantParam,
} from "../../../../runtime/ai/providers/anthropic.js";
import type { AssistantMessage, Message } from "../../../../runtime/ai/types.js";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4.7",
		usage,
		stopReason,
		timestamp: 0,
	};
}

function userMsg(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

describe("stripDanglingThinkingFromLatestAssistant (preventive)", () => {
	it("drops a trailing (dangling) thinking block left by a mid-reasoning interrupt", () => {
		const messages: Message[] = [
			userMsg("hello"),
			assistant([{ type: "thinking", thinking: "partial reasoning...", thinkingSignature: "sig" }]),
			userMsg("actually, do this instead"),
			assistant([
				{ type: "text", text: "on it" },
				{ type: "thinking", thinking: "still reasoning when interrupted", thinkingSignature: "sig2" },
			]),
		];

		const out = stripDanglingThinkingFromLatestAssistant(messages);
		const last = out[out.length - 1] as AssistantMessage;
		// The trailing thinking block is gone; the real text stays.
		expect(last.content).toEqual([{ type: "text", text: "on it" }]);
		// Earlier assistant turn is untouched.
		expect((out[1] as AssistantMessage).content).toHaveLength(1);
	});

	it("drops an incomplete (signature-less) thinking block from the latest assistant message", () => {
		const messages: Message[] = [
			userMsg("hi"),
			assistant([
				{ type: "thinking", thinking: "interrupted mid-thought" },
				{ type: "text", text: "partial answer" },
			]),
		];

		const out = stripDanglingThinkingFromLatestAssistant(messages);
		const last = out[out.length - 1] as AssistantMessage;
		expect(last.content).toEqual([{ type: "text", text: "partial answer" }]);
	});

	it("preserves a verbatim, signed thinking block that precedes real content", () => {
		const messages: Message[] = [
			userMsg("hi"),
			assistant([
				{ type: "thinking", thinking: "complete reasoning", thinkingSignature: "valid-sig" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			]),
		];

		const out = stripDanglingThinkingFromLatestAssistant(messages);
		// Same reference back means nothing changed.
		expect(out).toBe(messages);
	});

	it("makes a thinking-only interrupted turn empty so it is skipped downstream", () => {
		const messages: Message[] = [
			userMsg("hi"),
			assistant([{ type: "thinking", thinking: "just started thinking", thinkingSignature: "sig" }]),
		];

		const out = stripDanglingThinkingFromLatestAssistant(messages);
		const last = out[out.length - 1] as AssistantMessage;
		expect(last.content).toEqual([]);
	});

	it("only touches the latest assistant message, not earlier ones", () => {
		const earlier = assistant([{ type: "thinking", thinking: "old dangling", thinkingSignature: "s" }]);
		const messages: Message[] = [userMsg("hi"), earlier, userMsg("next"), assistant([{ type: "text", text: "done" }])];

		const out = stripDanglingThinkingFromLatestAssistant(messages);
		// Latest already clean -> unchanged reference.
		expect(out).toBe(messages);
		expect((out[1] as AssistantMessage).content).toHaveLength(1);
	});
});

describe("stripThinkingFromLastAssistantParam (reactive)", () => {
	it("removes thinking/redacted_thinking from the latest assistant param message", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reasoning", signature: "sig" },
					{ type: "redacted_thinking", data: "opaque" },
					{ type: "text", text: "answer" },
				],
			},
		];

		const out = stripThinkingFromLastAssistantParam(messages);
		expect(out).not.toBeNull();
		expect(out![1].content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("drops a thinking-only assistant message entirely", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "only reasoning", signature: "sig" }] },
		];

		const out = stripThinkingFromLastAssistantParam(messages);
		expect(out).not.toBeNull();
		expect(out).toHaveLength(1);
		expect(out![0].role).toBe("user");
	});

	it("returns null when there is nothing to strip", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		];

		expect(stripThinkingFromLastAssistantParam(messages)).toBeNull();
	});
});

describe("isLatestAssistantThinkingModifiedError (reactive detection)", () => {
	it("matches the Anthropic 400 message on a plain Error", () => {
		const err = new Error(
			"400 invalid_request_error: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
		);
		expect(isLatestAssistantThinkingModifiedError(err)).toBe(true);
	});

	it("matches the nested APIError payload shape", () => {
		const err = {
			status: 400,
			message: "400 Bad Request",
			error: {
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "thinking or redacted_thinking blocks in the latest assistant message cannot be modified.",
				},
			},
		};
		expect(isLatestAssistantThinkingModifiedError(err)).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isLatestAssistantThinkingModifiedError(new Error("429 rate limit"))).toBe(false);
		expect(isLatestAssistantThinkingModifiedError(null)).toBe(false);
		expect(isLatestAssistantThinkingModifiedError("boom")).toBe(false);
	});
});
