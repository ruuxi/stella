import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted)";

const hasImageDescription = (content: (TextContent | ImageContent)[]): boolean =>
	content.some(
		(block) => block.type === "text" && block.text.includes("<image_description>"),
	);

const imageReference = (image: ImageContent): string | null => {
	const sourcePath = image.sourcePath?.trim();
	if (!sourcePath) return null;
	return `<image_reference>\n${sourcePath}\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>`;
};

function downgradeImages(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const described = hasImageDescription(content);
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			const reference = imageReference(block);
			if (reference) {
				result.push({ type: "text", text: reference });
				previousWasPlaceholder = false;
			} else if (!described && !previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
				previousWasPlaceholder = true;
			}
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: downgradeImages(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: downgradeImages(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty or cross-model thinking blocks. Hidden reasoning must not
					// be replayed to a different model as visible assistant text.
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return [];
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	const validToolCallIds = new Set<string>();
	for (const message of transformed) {
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type === "toolCall") {
				validToolCallIds.add(block.id);
			}
		}
	}

	// Second pass: re-attach each assistant turn's tool results immediately after
	// it (in tool-call order) and drop any out-of-place result messages.
	//
	// Anthropic requires a tool_result's tool_use to be in the immediately
	// preceding message. Results can drift out of that position when a non-tool
	// message is recorded between a tool_use and its result — e.g. a
	// `runtime.task_lifecycle` reminder is persisted the moment a spawned
	// sub-agent finishes, racing just ahead of the orchestrator's tool-result
	// batch, so a later history rebuild interleaves reminder-then-results.
	// Anchoring each result to its call fixes the adjacency and collapses the
	// duplicate copy that such interleaving would otherwise leave behind (which
	// previously surfaced as the Anthropic 400 "tool_result ... must have a
	// corresponding tool_use block in the previous message").
	const realResultsById = new Map<string, ToolResultMessage>();
	for (const message of transformed) {
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultMessage;
		if (!validToolCallIds.has(toolResult.toolCallId)) continue;
		if (!realResultsById.has(toolResult.toolCallId)) {
			realResultsById.set(toolResult.toolCallId, toolResult);
		}
	}

	const result: Message[] = [];
	const emittedResultIds = new Set<string>();

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			// Skip errored/aborted assistant turns entirely. They are incomplete
			// (partial content, dangling tool calls) and replaying them can trip
			// provider validation; the model should retry from the last good state.
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}
			result.push(msg);
			// Emit this turn's tool results adjacently, in call order: the real
			// result when we have one, otherwise a synthetic placeholder so the
			// tool_use is never left dangling.
			for (const block of assistantMsg.content) {
				if (block.type !== "toolCall") continue;
				const toolCall = block as ToolCall;
				if (emittedResultIds.has(toolCall.id)) continue;
				emittedResultIds.add(toolCall.id);
				const realResult = realResultsById.get(toolCall.id);
				if (realResult) {
					result.push(realResult);
				} else {
					result.push({
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			continue;
		}
		// Real tool results are re-emitted adjacent to their assistant turn above;
		// any standalone occurrence here is a duplicate or an orphan (no valid
		// tool_use) and is dropped.
		if (msg.role === "toolResult") {
			continue;
		}
		result.push(msg);
	}

	return result;
}
