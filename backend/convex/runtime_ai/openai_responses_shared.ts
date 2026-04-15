import type OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
  Tool as OpenAITool,
} from "openai/resources/responses/responses.js";
import type { AssistantMessageEventStream } from "./event_stream";
import { parseStreamingJson } from "./json_parse";
import { calculateCost } from "./model_utils";
import { sanitizeSurrogates } from "./sanitize_unicode";
import { transformMessages } from "./transform_messages";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  StopReason,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from "./types";

function shortHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase) {
    payload.phase = phase;
  }
  return JSON.stringify(payload);
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return {
          id: parsed.id,
          phase:
            parsed.phase === "commentary" || parsed.phase === "final_answer"
              ? parsed.phase
              : undefined,
        };
      }
    } catch {
      // fall through
    }
  }
  return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
): ResponseInput {
  const messages: ResponseInput = [];

  const toInputImage = (
    item: ImageContent,
  ): ResponseInputImage | null => {
    const imageUrl = item.url || (
      item.mimeType && item.data ? `data:${item.mimeType};base64,${item.data}` : null
    );
    if (!imageUrl) {
      return null;
    }
    return {
      type: "input_image",
      detail: item.detail || "auto",
      image_url: imageUrl,
    } satisfies ResponseInputImage;
  };

  const normalizeToolCallId = (id: string): string => {
    if (!allowedToolCallProviders.has(model.provider) || !id.includes("|")) {
      return id;
    }
    const [callId, itemId] = id.split("|");
    const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!sanitizedItemId.startsWith("fc")) {
      sanitizedItemId = `fc_${sanitizedItemId}`;
    }
    return `${sanitizedCallId.slice(0, 64).replace(/_+$/, "")}|${sanitizedItemId
      .slice(0, 64)
      .replace(/_+$/, "")}`;
  };

  const transformedMessages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );

  if (context.systemPrompt) {
    messages.push({
      role: model.reasoning ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let messageIndex = 0;
  for (const message of transformedMessages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(message.content) }],
        });
      } else {
        const content: ResponseInputContent[] = message.content.map(
          (item): ResponseInputContent => {
            if (item.type === "text") {
              return {
                type: "input_text",
                text: sanitizeSurrogates(item.text),
              } satisfies ResponseInputText;
            }
            return toInputImage(item) as ResponseInputImage;
          },
        ).filter(Boolean);
        const filteredContent = model.input.includes("image")
          ? content
          : content.filter((item) => item.type !== "input_image");
        if (filteredContent.length > 0) {
          messages.push({ role: "user", content: filteredContent });
        }
      }
      messageIndex += 1;
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      messages.push({
        role: message.role,
        content: [{
          type: "input_text",
          text: sanitizeSurrogates(message.content),
        }],
      } as ResponseInput[number]);
      messageIndex += 1;
      continue;
    }

    if (message.role === "assistant") {
      const assistantOutput: ResponseInput = [];
      const assistantMessage = message as AssistantMessage;
      const isDifferentModel =
        assistantMessage.model !== model.id
        && assistantMessage.provider === model.provider
        && assistantMessage.api === model.api;

      for (const block of assistantMessage.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            assistantOutput.push(
              JSON.parse(block.thinkingSignature) as ResponseReasoningItem,
            );
          }
          continue;
        }

        if (block.type === "text") {
          const parsedSignature = parseTextSignature(block.textSignature);
          let messageId = parsedSignature?.id || `msg_${messageIndex}`;
          if (messageId.length > 64) {
            messageId = `msg_${shortHash(messageId)}`;
          }
          const responseMessage = {
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: sanitizeSurrogates(block.text),
              annotations: [],
            }],
            status: "completed",
            id: messageId,
          } as ResponseOutputMessage & { phase?: TextSignatureV1["phase"] };
          if (parsedSignature?.phase) {
            responseMessage.phase = parsedSignature.phase;
          }
          assistantOutput.push(responseMessage);
          continue;
        }

        const [callId, itemIdRaw] = block.id.split("|");
        assistantOutput.push({
          type: "function_call",
          id:
            isDifferentModel && itemIdRaw?.startsWith("fc_")
              ? undefined
              : itemIdRaw,
          call_id: callId,
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        });
      }

      if (assistantOutput.length > 0) {
        messages.push(...assistantOutput);
      }
      messageIndex += 1;
      continue;
    }

    if (message.role !== "toolResult") {
      continue;
    }

    const textResult = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const hasImages = message.content.some(
      (block): block is ImageContent => block.type === "image",
    );
    const [callId] = message.toolCallId.split("|");

    let output: string | ResponseFunctionCallOutputItemList;
    if (hasImages && model.input.includes("image")) {
      const outputParts: ResponseFunctionCallOutputItemList = [];
      if (textResult) {
        outputParts.push({
          type: "input_text",
          text: sanitizeSurrogates(textResult),
        });
      }
      for (const block of message.content) {
        if (block.type === "image") {
          const inputImage = toInputImage(block);
          if (inputImage) {
            outputParts.push(inputImage);
          }
        }
      }
      output = outputParts;
    } else {
      output = sanitizeSurrogates(textResult || "(see attached image)");
    }

    messages.push({
      type: "function_call_output",
      call_id: callId,
      output,
    });
    messageIndex += 1;
  }

  return messages;
}

export function convertResponsesTools(tools: Tool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict ?? false,
  }));
}

export async function processResponsesStream<TApi extends Api>(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
  let currentBlock:
    | ThinkingContent
    | TextContent
    | (ToolCall & { partialJson: string })
    | null = null;

  const contentIndex = () => output.content.length - 1;

  for await (const event of openaiStream) {
    if (event.type === "response.output_item.added") {
      if (event.item.type === "reasoning") {
        currentItem = event.item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: contentIndex(), partial: output });
      } else if (event.item.type === "message") {
        currentItem = event.item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: contentIndex(), partial: output });
      } else if (event.item.type === "function_call") {
        currentItem = event.item;
        currentBlock = {
          type: "toolCall",
          id: `${event.item.call_id}|${event.item.id}`,
          name: event.item.name,
          arguments: {},
          partialJson: event.item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: contentIndex(), partial: output });
      }
      continue;
    }

    if (
      event.type === "response.reasoning_summary_text.delta"
      || event.type === "response.reasoning_text.delta"
    ) {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking += event.delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: contentIndex(),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (
      event.type === "response.reasoning_summary_text.done"
      || event.type === "response.reasoning_text.done"
    ) {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = event.text || currentBlock.thinking;
      }
      continue;
    }

    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: contentIndex(),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: contentIndex(),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
      }
      continue;
    }

    if (event.type === "response.output_item.done") {
      if (event.item.type === "reasoning" && currentBlock?.type === "thinking") {
        const directReasoningText = event.item.content
          ?.filter((part): part is { type: "reasoning_text"; text: string } =>
            part.type === "reasoning_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n\n");
        currentBlock.thinking =
          event.item.summary?.map((part) => part.text).join("\n\n")
          || directReasoningText
          || currentBlock.thinking;
        currentBlock.thinkingSignature = JSON.stringify(event.item);
        stream.push({
          type: "thinking_end",
          contentIndex: contentIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (event.item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = event.item.content
          .map((content) => (content.type === "output_text" ? content.text : content.refusal))
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(
          event.item.id,
          (event.item as ResponseOutputMessage & { phase?: TextSignatureV1["phase"] }).phase,
        );
        stream.push({
          type: "text_end",
          contentIndex: contentIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (event.item.type === "function_call") {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: `${event.item.call_id}|${event.item.id}`,
          name: event.item.name,
          arguments:
            currentBlock?.type === "toolCall"
              ? currentBlock.arguments
              : parseStreamingJson(event.item.arguments || "{}"),
        };
        currentBlock = null;
        stream.push({
          type: "toolcall_end",
          contentIndex: contentIndex(),
          toolCall,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.completed") {
      const response = event.response;
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        const reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens || 0;
        output.usage = {
          input: response.usage.input_tokens || 0,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          reasoningTokens,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        calculateCost(model, output.usage);
        options?.applyServiceTierPricing?.(
          output.usage,
          response.service_tier ?? options.serviceTier,
        );
      }
      output.stopReason = mapStopReason(response?.status);
      if (output.stopReason === "stop" && output.content.some((block) => block.type === "toolCall")) {
        output.stopReason = "toolUse";
      }
      continue;
    }

    if (event.type === "response.failed") {
      const error = event.response?.error;
      throw new Error(
        error ? `${error.code || "unknown"}: ${error.message || "no message"}` : "Unknown error",
      );
    }

    if (event.type === "error") {
      throw new Error(
        event.message ? `Error Code ${event.code}: ${event.message}` : "Unknown error",
      );
    }
  }
}

function mapStopReason(
  status: OpenAI.Responses.ResponseStatus | undefined,
): StopReason {
  switch (status) {
    case undefined:
    case "completed":
    case "in_progress":
    case "queued":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
    default:
      return "error";
  }
}
