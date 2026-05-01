import {
  GoogleGenAI,
  type Content,
  type FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type Part,
} from "@google/genai";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  TextContent,
  ToolCall,
} from "./types";
import { AssistantMessageEventStream } from "./event_stream";
import { buildBaseOptions, clampReasoning } from "./simple_options";
import { transformMessages } from "./transform_messages";
import { sanitizeSurrogates } from "./sanitize_unicode";

type GoogleToolChoice = "auto" | "none" | "any";

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeGoogleModelId(modelId: string): string {
  return modelId.startsWith("google/") ? modelId.slice("google/".length) : modelId;
}

function convertMessages(model: Model<"google-generative-ai">, context: Context): Content[] {
  const contents: Content[] = [];
  for (const message of transformMessages(context.messages, model)) {
    if (message.role === "system" || message.role === "developer") {
      continue;
    }
    if (message.role === "user") {
      const parts: Part[] = typeof message.content === "string"
        ? [{ text: sanitizeSurrogates(message.content) }]
        : message.content
            .map((block): Part | null => {
              if (block.type === "text") {
                return { text: sanitizeSurrogates(block.text) };
              }
              if (!model.input.includes("image") || !block.data || !block.mimeType) {
                return null;
              }
              return { inlineData: { mimeType: block.mimeType, data: block.data } };
            })
            .filter((part): part is Part => part !== null);
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
      continue;
    }
    if (message.role === "assistant") {
      const parts: Part[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          parts.push({ text: sanitizeSurrogates(block.text) });
        } else if (block.type === "thinking" && block.thinking.trim()) {
          parts.push({ text: sanitizeSurrogates(block.thinking), thought: true });
        } else if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.arguments,
            },
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const text = message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            id: message.toolCallId,
            name: message.toolName,
            response: message.isError
              ? { error: sanitizeSurrogates(text) }
              : { output: sanitizeSurrogates(text) },
          },
        }],
      });
    }
  }
  return contents;
}

function convertTools(context: Context): GenerateContentConfig["tools"] | undefined {
  if (!context.tools || context.tools.length === 0) {
    return undefined;
  }
  return [{
    functionDeclarations: context.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];
}

function mapToolChoice(choice: GoogleToolChoice | undefined): GenerateContentConfig["toolConfig"] | undefined {
  if (!choice || choice === "auto") {
    return undefined;
  }
  return {
    functionCallingConfig: {
      mode: choice === "none"
        ? "NONE" as FunctionCallingConfigMode
        : "ANY" as FunctionCallingConfigMode,
    },
  };
}

function thinkingBudget(reasoning: SimpleStreamOptions["reasoning"]): number | undefined {
  switch (clampReasoning(reasoning)) {
    case "minimal":
      return 512;
    case "low":
      return 1024;
    case "medium":
      return -1;
    case "high":
      return -1;
    default:
      return undefined;
  }
}

function mapStopReason(reason: string | undefined): AssistantMessage["stopReason"] {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "STOP":
    case "FINISH_REASON_UNSPECIFIED":
    default:
      return "stop";
  }
}

function buildParams(
  model: Model<"google-generative-ai">,
  context: Context,
  options?: SimpleStreamOptions,
): GenerateContentParameters {
  const budgetTokens = thinkingBudget(options?.reasoning);
  return {
    model: normalizeGoogleModelId(model.id),
    contents: convertMessages(model, context),
    config: {
      systemInstruction: context.systemPrompt,
      temperature: options?.temperature,
      maxOutputTokens: options?.maxTokens ?? model.maxTokens,
      tools: convertTools(context),
      toolConfig: mapToolChoice(context.tools && context.tools.length > 0 ? "auto" : undefined),
      thinkingConfig: budgetTokens !== undefined
        ? {
            includeThoughts: true,
            thinkingBudget: budgetTokens,
          }
        : undefined,
    },
  };
}

export const streamGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model,
  context,
  options,
) => {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "google-generative-ai",
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const apiKey = options?.apiKey?.trim();
      if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");
      const client = new GoogleGenAI({ apiKey, httpOptions: { headers: { ...model.headers, ...options?.headers } } });
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) params = nextParams as GenerateContentParameters;
      const googleStream = await client.models.generateContentStream(params);
      stream.push({ type: "start", partial: output });
      let activeIndex: number | null = null;
      let toolCounter = 0;
      for await (const chunk of googleStream) {
        output.responseId ||= chunk.responseId;
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === "string") {
            const isThinking = part.thought === true;
            const active = activeIndex === null ? null : output.content[activeIndex];
            if (!active || (isThinking && active.type !== "thinking") || (!isThinking && active.type !== "text")) {
              if (active?.type === "text") {
                stream.push({ type: "text_end", contentIndex: activeIndex!, content: active.text, partial: output });
              } else if (active?.type === "thinking") {
                stream.push({
                  type: "thinking_end",
                  contentIndex: activeIndex!,
                  content: active.thinking,
                  partial: output,
                });
              }
              output.content.push(isThinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
              activeIndex = output.content.length - 1;
              stream.push({
                type: isThinking ? "thinking_start" : "text_start",
                contentIndex: activeIndex,
                partial: output,
              });
            }
            if (activeIndex === null) continue;
            const currentIndex = activeIndex;
            const current = output.content[currentIndex];
            if (current?.type === "thinking") {
              current.thinking += part.text;
              if (part.thoughtSignature) current.thinkingSignature = part.thoughtSignature;
              stream.push({ type: "thinking_delta", contentIndex: currentIndex, delta: part.text, partial: output });
            } else if (current?.type === "text") {
              current.text += part.text;
              if (part.thoughtSignature) current.textSignature = part.thoughtSignature;
              stream.push({ type: "text_delta", contentIndex: currentIndex, delta: part.text, partial: output });
            }
          }
          if (part.functionCall) {
            if (activeIndex !== null) {
              const active = output.content[activeIndex];
              if (active?.type === "text") {
                stream.push({ type: "text_end", contentIndex: activeIndex, content: active.text, partial: output });
              } else if (active?.type === "thinking") {
                stream.push({
                  type: "thinking_end",
                  contentIndex: activeIndex,
                  content: active.thinking,
                  partial: output,
                });
              }
              activeIndex = null;
            }
            const toolCall: ToolCall = {
              type: "toolCall",
              id: part.functionCall.id || `${part.functionCall.name}_${Date.now()}_${++toolCounter}`,
              name: part.functionCall.name || "",
              arguments: part.functionCall.args as Record<string, unknown> ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            };
            output.content.push(toolCall);
            const index = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
          }
        }
        if (candidate?.finishReason) output.stopReason = mapStopReason(candidate.finishReason);
        if (chunk.usageMetadata) {
          output.usage.input =
            (chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0);
          output.usage.output =
            (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0);
          output.usage.cacheRead = chunk.usageMetadata.cachedContentTokenCount || 0;
          output.usage.reasoningTokens = chunk.usageMetadata.thoughtsTokenCount || 0;
          output.usage.totalTokens = chunk.usageMetadata.totalTokenCount || 0;
        }
      }
      if (activeIndex !== null) {
        const active = output.content[activeIndex];
        if (active?.type === "text") {
          stream.push({ type: "text_end", contentIndex: activeIndex, content: active.text, partial: output });
        } else if (active?.type === "thinking") {
          stream.push({ type: "thinking_end", contentIndex: activeIndex, content: active.thinking, partial: output });
        }
      }
      if (output.content.some((block): block is ToolCall => block.type === "toolCall")) {
        output.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model,
  context,
  options,
) => streamGoogle(model, context, buildBaseOptions(model, options, options?.apiKey) as SimpleStreamOptions);
