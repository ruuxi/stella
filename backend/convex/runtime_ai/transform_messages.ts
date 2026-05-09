import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "./types";

export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (
    id: string,
    model: Model<TApi>,
    source: AssistantMessage,
  ) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();

  const transformed = messages.map((message) => {
    if (
      message.role === "user"
      || message.role === "system"
      || message.role === "developer"
    ) {
      return message;
    }

    if (message.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(message.toolCallId);
      if (normalizedId && normalizedId !== message.toolCallId) {
        return { ...message, toolCallId: normalizedId };
      }
      return message;
    }

    const assistantMessage = message as AssistantMessage;
    const isSameModel =
      assistantMessage.provider === model.provider
      && assistantMessage.api === model.api
      && assistantMessage.model === model.id;

    const transformedContent = assistantMessage.content.flatMap((block) => {
      if (block.type === "thinking") {
        if (block.redacted) {
          return isSameModel ? block : [];
        }
        if (isSameModel && block.thinkingSignature) {
          return block;
        }
        if (!block.thinking || block.thinking.trim() === "") {
          return [];
        }
        return isSameModel ? block : [];
      }

      if (block.type === "text") {
        return isSameModel ? block : { type: "text" as const, text: block.text };
      }

      const toolCall = block as ToolCall;
      let normalizedToolCall: ToolCall = toolCall;

      if (!isSameModel && toolCall.thoughtSignature) {
        normalizedToolCall = { ...toolCall };
        delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
      }

      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMessage);
        if (normalizedId !== toolCall.id) {
          toolCallIdMap.set(toolCall.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }

      return normalizedToolCall;
    });

    return {
      ...assistantMessage,
      content: transformedContent,
    };
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  const flushPendingToolResults = () => {
    if (pendingToolCalls.length === 0) {
      return;
    }

    for (const toolCall of pendingToolCalls) {
      if (!existingToolResultIds.has(toolCall.id)) {
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

    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      flushPendingToolResults();

      const assistantMessage = message as AssistantMessage;
      if (
        assistantMessage.stopReason === "error"
        || assistantMessage.stopReason === "aborted"
      ) {
        continue;
      }

      const toolCalls = assistantMessage.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }

      result.push(message);
      continue;
    }

    if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
      result.push(message);
      continue;
    }

    flushPendingToolResults();
    result.push(message);
  }

  flushPendingToolResults();
  return result;
}
