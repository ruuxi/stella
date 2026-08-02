import type {
	ImageBlockParam,
	MessageParam,
	TextBlockParam,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";

import { convertMessages } from "../../../../runtime/ai/providers/anthropic.js";
import {
	detectImageMediaType,
	isCompleteImage,
	MAX_IMAGE_BASE64_BYTES,
	sanitizeInlineImagePayload,
} from "../../../../runtime/ai/utils/image-payload.js";
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

// A complete, valid PNG with exporter-style metadata appended AFTER the IEND
// terminator — the shape that an exact last-8-bytes match would false-reject.
const PNG_WITH_TRAILING_BASE64 = (() => {
	const full = Buffer.from(VALID_PNG_BASE64, "base64");
	const trailer = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
	return Buffer.concat([full, trailer]).toString("base64");
})();

// A minimal complete JPEG (SOI + APP0/JFIF + EOI) with padding after the EOI
// marker — cameras/exporters commonly append bytes after 0xFFD9.
const JPEG_WITH_TRAILING_BASE64 = (() => {
	const jpeg = Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
		0xff, 0xd9,
	]);
	const trailer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
	return Buffer.concat([jpeg, trailer]);
})();

// A minimal complete WEBP: RIFF preamble whose declared size matches the bytes
// that follow it.
const VALID_WEBP_BYTES = (() => {
	const bytes = Buffer.alloc(20);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(bytes.length - 8, 4); // declared payload size
	bytes.write("WEBP", 8, "ascii");
	return bytes;
})();

// Build a PNG-shaped buffer of an exact base64 length: valid PNG signature at
// the head and a real IEND+CRC terminator at the tail, so only the size gate
// can reject it.
const pngOfBase64Length = (targetBase64Len: number): string => {
	const binaryLen = Math.floor((targetBase64Len / 4) * 3);
	const buf = Buffer.alloc(binaryLen, 0x00);
	const full = Buffer.from(VALID_PNG_BASE64, "base64");
	full.copy(buf, 0); // PNG signature + IHDR at the head
	// IEND chunk (length + "IEND" + CRC) as the final 12 bytes.
	full.subarray(full.length - 12).copy(buf, buf.length - 12);
	const data = buf.toString("base64");
	return data;
};

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
		{ role: "user", content: "run Read", timestamp: 0 },
		{
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4.7",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
			content: [
				{ type: "toolCall", id: "toolu_test", name: "Read", arguments: {} },
			],
		},
		toolResult(content),
	];
}

function toolResult(content: Message["content"]): Message {
	return {
		role: "toolResult",
		toolCallId: "toolu_test",
		toolName: "Read",
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

	it("passes a valid image with trailing bytes after its terminator (no false-reject)", () => {
		const messages: Message[] = withToolCall([
			{ type: "text", text: "here is the screenshot" },
			{ type: "image", data: PNG_WITH_TRAILING_BASE64, mimeType: "image/png" },
		]);

		const params = convertMessages(messages, model, false);
		const blocks = firstToolResult(params).content as Array<
			TextBlockParam | ImageBlockParam
		>;
		const image = blocks.find((b): b is ImageBlockParam => b.type === "image");
		expect(image, "PNG with post-IEND metadata must not be dropped").toBeDefined();
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
		// ~9MB decoded => ~12MB base64, comfortably over the 10MB direct-API cap.
		const oversized = Buffer.alloc(9 * 1024 * 1024, 0x00);
		// Give it a valid PNG header + IEND so only the size gate can reject it.
		const png = Buffer.from(VALID_PNG_BASE64, "base64");
		png.copy(oversized, 0);
		png.subarray(png.length - 12).copy(oversized, oversized.length - 12);
		expect(sanitizeInlineImagePayload(oversized.toString("base64"), "image/png")).toBeNull();
	});

	it("keeps a valid image whose bytes carry trailing data after the terminator", () => {
		expect(sanitizeInlineImagePayload(PNG_WITH_TRAILING_BASE64, "image/png")).toEqual({
			mediaType: "image/png",
			data: PNG_WITH_TRAILING_BASE64,
		});
		const jpeg = JPEG_WITH_TRAILING_BASE64.toString("base64");
		expect(sanitizeInlineImagePayload(jpeg, "image/jpeg")).toEqual({
			mediaType: "image/jpeg",
			data: jpeg,
		});
	});

	it("enforces the shared 10MB base64 ceiling at its exact boundary", () => {
		expect(MAX_IMAGE_BASE64_BYTES).toBe(10 * 1024 * 1024);

		// Exactly at the ceiling passes (`>` comparison, not `>=`).
		const atLimit = pngOfBase64Length(MAX_IMAGE_BASE64_BYTES);
		expect(atLimit.length).toBe(MAX_IMAGE_BASE64_BYTES);
		expect(sanitizeInlineImagePayload(atLimit, "image/png")).not.toBeNull();

		// One base64 quantum over the ceiling is rejected.
		const overLimit = pngOfBase64Length(MAX_IMAGE_BASE64_BYTES + 4);
		expect(overLimit.length).toBeGreaterThan(MAX_IMAGE_BASE64_BYTES);
		expect(sanitizeInlineImagePayload(overLimit, "image/png")).toBeNull();
	});
});

describe("isCompleteImage (terminator scanning)", () => {
	it("accepts terminators found within the bounded trailing window", () => {
		const png = Buffer.from(PNG_WITH_TRAILING_BASE64, "base64");
		expect(isCompleteImage(png, "image/png")).toBe(true);
		expect(isCompleteImage(JPEG_WITH_TRAILING_BASE64, "image/jpeg")).toBe(true);

		// GIF: header + trailer (0x3B) + a couple trailing bytes within window.
		const gif = Buffer.concat([
			Buffer.from("GIF89a", "ascii"),
			Buffer.from([0x00, 0x00, 0x3b, 0x00, 0x00]),
		]);
		expect(isCompleteImage(gif, "image/gif")).toBe(true);
	});

	it("still rejects genuinely truncated streams (no terminator present)", () => {
		const truncatedPng = Buffer.from(TRUNCATED_PNG_BASE64, "base64");
		expect(isCompleteImage(truncatedPng, "image/png")).toBe(false);

		const truncatedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		expect(isCompleteImage(truncatedJpeg, "image/jpeg")).toBe(false);
	});

	it("reads the WEBP declared size as unsigned (no signed <<24 overflow)", () => {
		expect(detectImageMediaType(VALID_WEBP_BYTES)).toBe("image/webp");
		expect(isCompleteImage(VALID_WEBP_BYTES, "image/webp")).toBe(true);

		// Declared size with bit 31 set (~2GiB): read signed it would be a large
		// negative number and `bytes.length >= declared + 8` would wrongly pass.
		// Read unsigned it is huge, so a tiny buffer is correctly incomplete.
		const bogus = Buffer.alloc(20);
		bogus.write("RIFF", 0, "ascii");
		bogus[4] = 0x00;
		bogus[5] = 0x00;
		bogus[6] = 0x00;
		bogus[7] = 0x80; // MSB set
		bogus.write("WEBP", 8, "ascii");
		expect(isCompleteImage(bogus, "image/webp")).toBe(false);
	});
});
