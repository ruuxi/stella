import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createThinkingAbortGate, streamAnthropic } from "../../../../runtime/ai/providers/anthropic.js";
import type { AssistantMessageEvent, Context, Model } from "../../../../runtime/ai/types.js";

// --- Gate unit tests: the boundary state machine in isolation -------------

describe("createThinkingAbortGate", () => {
	// Injected timer that records the scheduled callback without firing it, so
	// timeout behavior is deterministic (no real clocks).
	function withCapturedTimer() {
		let scheduled: (() => void) | undefined;
		let cleared = false;
		return {
			setTimer: (fn: () => void) => {
				scheduled = fn;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {
				cleared = true;
			},
			fire: () => scheduled?.(),
			get cleared() {
				return cleared;
			},
			get hasScheduled() {
				return scheduled !== undefined;
			},
		};
	}

	it("(1) defers an abort that lands mid-thinking until the block closes", () => {
		const onForwardAbort = vi.fn();
		const timer = withCapturedTimer();
		const gate = createThinkingAbortGate({ onForwardAbort, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

		gate.openThinkingBlock();
		gate.requestAbort();

		expect(onForwardAbort).not.toHaveBeenCalled();
		expect(gate.isDeferring).toBe(true);
		expect(timer.hasScheduled).toBe(true);

		gate.closeThinkingBlock();

		expect(onForwardAbort).toHaveBeenCalledTimes(1);
		expect(gate.isDeferring).toBe(false);
		expect(timer.cleared).toBe(true);
	});

	it("(2) forwards immediately when the abort lands outside a thinking block", () => {
		const onForwardAbort = vi.fn();
		const gate = createThinkingAbortGate({ onForwardAbort });

		gate.requestAbort();

		expect(onForwardAbort).toHaveBeenCalledTimes(1);
		expect(gate.isDeferring).toBe(false);
	});

	it("(2b) forwards immediately once the thinking block has already closed", () => {
		const onForwardAbort = vi.fn();
		const gate = createThinkingAbortGate({ onForwardAbort });

		gate.openThinkingBlock();
		gate.closeThinkingBlock();
		gate.requestAbort();

		expect(onForwardAbort).toHaveBeenCalledTimes(1);
	});

	it("(3) forwards on timeout when the block never closes, and does not double-forward", () => {
		const onForwardAbort = vi.fn();
		const timer = withCapturedTimer();
		const gate = createThinkingAbortGate({
			onForwardAbort,
			timeoutMs: 10,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});

		gate.openThinkingBlock();
		gate.requestAbort();
		expect(onForwardAbort).not.toHaveBeenCalled();

		// Simulate the bounded timeout elapsing on a runaway reasoning block.
		timer.fire();
		expect(onForwardAbort).toHaveBeenCalledTimes(1);

		// A late block-close must not fire a second abort.
		gate.closeThinkingBlock();
		expect(onForwardAbort).toHaveBeenCalledTimes(1);
	});

	it("defaults the defer timeout to 3s when none is provided", () => {
		let scheduledMs: number | undefined;
		const gate = createThinkingAbortGate({
			onForwardAbort: vi.fn(),
			setTimer: (_fn, ms) => {
				scheduledMs = ms;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {},
		});

		gate.openThinkingBlock();
		gate.requestAbort();

		expect(scheduledMs).toBe(3_000);
	});

	it("is idempotent across repeated abort requests", () => {
		const onForwardAbort = vi.fn();
		const gate = createThinkingAbortGate({ onForwardAbort });

		gate.requestAbort();
		gate.requestAbort();

		expect(onForwardAbort).toHaveBeenCalledTimes(1);
	});
});

// --- Integration: streamAnthropic wired to the gate at the real boundary --

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-4.7",
	name: "Claude Opus 4.7",
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

/**
 * Fake Anthropic SDK client that streams SSE events we push manually and wires
 * its response body to the request's abort signal (mirroring how a real fetch
 * body cancels when aborted).
 */
function makeFakeClient() {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const encoder = new TextEncoder();

	const create = (_body: unknown, opts?: { signal?: AbortSignal }) => ({
		asResponse: async () => {
			const signal = opts?.signal;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					const abortBody = () => {
						try {
							c.error(new Error("Request was aborted"));
						} catch {
							// already closed/errored
						}
					};
					if (signal) {
						if (signal.aborted) abortBody();
						else signal.addEventListener("abort", abortBody);
					}
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
	});

	const client = { messages: { create } } as unknown as Anthropic;
	const push = (event: string, data: unknown) => {
		controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
	};
	return { client, push };
}

const messageStart = {
	type: "message_start",
	message: {
		id: "msg_test",
		usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
};

const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(stream: AsyncIterable<AssistantMessageEvent>, sink: AssistantMessageEvent[]) {
	for await (const event of stream) sink.push(event);
}

const types = (events: AssistantMessageEvent[]) => events.map((e) => e.type);

afterEach(() => {
	delete process.env.STELLA_THINKING_ABORT_DEFER_TIMEOUT_MS;
	vi.restoreAllMocks();
});

describe("streamAnthropic boundary-aware interrupt", () => {
	it("defers a mid-thinking abort until the thinking block seals, then applies it", async () => {
		const { client, push } = makeFakeClient();
		const external = new AbortController();
		const events: AssistantMessageEvent[] = [];

		const stream = streamAnthropic(model, context, {
			client,
			signal: external.signal,
			thinkingEnabled: true,
		});
		const done = collect(stream, events);

		// Let the stream reach `asResponse()` so the fake body controller exists.
		await tick();
		push("message_start", messageStart);
		push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
		push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } });
		await tick();
		expect(types(events)).toContain("thinking_delta");

		// Interrupt lands mid thinking block.
		external.abort();
		await tick(30);

		// Deferred: the stream must NOT have torn down while the block is open.
		expect(types(events)).not.toContain("error");
		expect(types(events)).not.toContain("done");

		// Seal the thinking block: signature then content_block_stop.
		push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } });
		push("content_block_stop", { type: "content_block_stop", index: 0 });
		await tick(30);
		await done;

		// The abort applied at the clean boundary: the thinking block sealed
		// (thinking_end emitted) and then the stream tore down as aborted.
		expect(types(events)).toContain("thinking_end");
		const error = events.find((e) => e.type === "error");
		expect(error).toBeDefined();
		expect((error as Extract<AssistantMessageEvent, { type: "error" }>).reason).toBe("aborted");
	});

	it("applies an abort immediately when it lands outside a thinking block", async () => {
		const { client, push } = makeFakeClient();
		const external = new AbortController();
		const events: AssistantMessageEvent[] = [];

		const stream = streamAnthropic(model, context, {
			client,
			signal: external.signal,
			thinkingEnabled: true,
		});
		const done = collect(stream, events);

		await tick();
		push("message_start", messageStart);
		push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } });
		await tick();
		expect(types(events)).toContain("text_delta");

		// No open thinking block -> teardown is immediate (no extra events needed).
		external.abort();
		await tick(30);
		await done;

		const error = events.find((e) => e.type === "error");
		expect(error).toBeDefined();
		expect((error as Extract<AssistantMessageEvent, { type: "error" }>).reason).toBe("aborted");
	});

	it("does not wedge on a runaway thinking block: the bounded timeout forces teardown", async () => {
		process.env.STELLA_THINKING_ABORT_DEFER_TIMEOUT_MS = "20";
		const { client, push } = makeFakeClient();
		const external = new AbortController();
		const events: AssistantMessageEvent[] = [];

		const stream = streamAnthropic(model, context, {
			client,
			signal: external.signal,
			thinkingEnabled: true,
		});
		const done = collect(stream, events);

		await tick();
		push("message_start", messageStart);
		push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
		push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "runaway" } });
		await tick();

		// Interrupt lands mid-thinking and the block never closes.
		external.abort();
		// Shorter than the 20ms bound: still deferred.
		await tick(5);
		expect(types(events)).not.toContain("error");

		// Past the bound: teardown is forced rather than wedging user input.
		await tick(40);
		await done;

		const error = events.find((e) => e.type === "error");
		expect(error).toBeDefined();
		expect((error as Extract<AssistantMessageEvent, { type: "error" }>).reason).toBe("aborted");
	});
});
