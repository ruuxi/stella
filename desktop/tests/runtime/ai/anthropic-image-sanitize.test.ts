import type {
	ImageBlockParam,
	MessageParam,
	TextBlockParam,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";

import { convertMessages } from "../../../../runtime/ai/providers/anthropic.js";
import { sanitizeInlineImagePayload } from "../../../../runtime/ai/utils/image-payload.js";
import type { Message, Model } from "../../../../runtime/ai/types.js";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-4.7",
	name: "Claude Opus 4.7",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 128_000,
	contextWindow: 200_000,
};

// A complete, valid 1x1 PNG.
const VALID_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

// The exact failure shape from the reproduction thread: a PNG whose header +
// IHDR are intact (so magic-byte detection and dimension parsing succeed) but
// whose stream is cut off before the IEND terminator — a screenshot captured
// mid-write. Anthropic decodes server-side and rejects the whole request with
// `400 "Could not process image"`.
const TRUNCATED_PNG_BASE64 = (() => {
	const full = Buffer.from(VALID_PNG_BASE64, "base64");
	// Drop the trailing IEND chunk (and part of IDAT) to truncate the stream.
	return full.subarray(0, full.length - 16).toString("base64");
})();

const OMISSION_NOTE = "[Image omitted:";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// A tool result must be preceded by the assistant tool call that produced it,
// otherwise it is treated as dangling and dropped before conversion.
function withToolCall(content: Message["content"]): Message[] {
	return [
		{ role: "user", content: "run view_image", timestamp: 0 },
		{
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4.7",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
			content: [
				{ type: "toolCall", id: "toolu_test", name: "view_image", arguments: {} },
			],
		},
		toolResult(content),
	];
}

function toolResult(content: Message["content"]): Message {
	return {
		role: "toolResult",
		toolCallId: "toolu_test",
		toolName: "view_image",
		content: content as Exclude<Message["content"], string>,
		isError: false,
		timestamp: 0,
	};
}

function firstToolResult(params: MessageParam[]): ToolResultBlockParam {
	const user = params.find(
		(p) =>
			p.role === "user" &&
			Array.isArray(p.content) &&
			p.content.some((b) => (b as { type?: string }).type === "tool_result"),
	);
	expect(user, "expected a user message carrying a tool_result").toBeDefined();
	const block = (user!.content as unknown[]).find(
		(b) => (b as { type?: string }).type === "tool_result",
	) as ToolResultBlockParam;
	return block;
}

describe("anthropic image sanitization (tool-produced images)", () => {
	it("drops a truncated tool-result image and substitutes a note instead of poisoning the request", () => {
		const messages: Message[] = withToolCall([
			{ type: "text", text: "[Screenshot attached below.]" },
			{ type: "image", data: TRUNCATED_PNG_BASE64, mimeType: "image/png" },
		]);

		const params = convertMessages(messages, model, false);
		const result = firstToolResult(params);
		const blocks = result.content as Array<TextBlockParam | ImageBlockParam>;

		// No corrupt image block reaches the wire...
		expect(blocks.some((b) => b.type === "image")).toBe(false);
		// ...and the model still sees a note explaining the omission.
		const noteText = blocks
			.filter((b): b is TextBlockParam => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		expect(noteText).toContain(OMISSION_NOTE);
	});

	it("passes a complete, valid tool-result image through as a base64 image block", () => {
		const messages: Message[] = withToolCall([
			{ type: "text", text: "here is the screenshot" },
			{ type: "image", data: VALID_PNG_BASE64, mimeType: "image/png" },
		]);

		const params = convertMessages(messages, model, false);
		const blocks = firstToolResult(params).content as Array<
			TextBlockParam | ImageBlockParam
		>;
		const image = blocks.find((b): b is ImageBlockParam => b.type === "image");
		expect(image).toBeDefined();
		expect(image!.source).toMatchObject({
			type: "base64",
			media_type: "image/png",
			data: VALID_PNG_BASE64,
		});
	});

	it("corrects a misdetected media type from the actual bytes", () => {
		const messages: Message[] = withToolCall([
			// Bytes are PNG, but the tool mislabeled the mime as gif.
			{ type: "image", data: VALID_PNG_BASE64, mimeType: "image/gif" },
		]);

		const params = convertMessages(messages, model, false);
		const blocks = firstToolResult(params).content as Array<
			TextBlockParam | ImageBlockParam
		>;
		const image = blocks.find((b): b is ImageBlockParam => b.type === "image");
		expect(image).toBeDefined();
		expect((image!.source as { media_type: string }).media_type).toBe("image/png");
	});

	it("does not regress the user-attached image path", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{ type: "image", data: VALID_PNG_BASE64, mimeType: "image/png" },
				],
				timestamp: 0,
			},
		];

		const params = convertMessages(messages, model, false);
		const user = params.find((p) => p.role === "user")!;
		const blocks = user.content as Array<TextBlockParam | ImageBlockParam>;
		const image = blocks.find((b): b is ImageBlockParam => b.type === "image");
		expect(image).toBeDefined();
		expect((image!.source as { data: string }).data).toBe(VALID_PNG_BASE64);
	});
});

describe("sanitizeInlineImagePayload (unit)", () => {
	it("rejects a truncated PNG", () => {
		expect(sanitizeInlineImagePayload(TRUNCATED_PNG_BASE64, "image/png")).toBeNull();
	});

	it("keeps a valid PNG and normalizes the media type from bytes", () => {
		expect(sanitizeInlineImagePayload(VALID_PNG_BASE64, "image/gif")).toEqual({
			mediaType: "image/png",
			data: VALID_PNG_BASE64,
		});
	});

	it("strips a data: URI prefix and returns raw base64", () => {
		const result = sanitizeInlineImagePayload(
			`data:image/png;base64,${VALID_PNG_BASE64}`,
			"image/png",
		);
		expect(result).toEqual({ mediaType: "image/png", data: VALID_PNG_BASE64 });
	});

	it("rejects empty, non-image, and oversized payloads", () => {
		expect(sanitizeInlineImagePayload("", "image/png")).toBeNull();
		expect(sanitizeInlineImagePayload(Buffer.from("not an image").toString("base64"), "image/png")).toBeNull();
		const oversized = Buffer.alloc(6 * 1024 * 1024, 0x00);
		// Give it a valid PNG header + IEND so only the size gate can reject it.
		const png = Buffer.from(VALID_PNG_BASE64, "base64");
		png.copy(oversized, 0);
		png.subarray(png.length - 12).copy(oversized, oversized.length - 12);
		expect(sanitizeInlineImagePayload(oversized.toString("base64"), "image/png")).toBeNull();
	});
});
