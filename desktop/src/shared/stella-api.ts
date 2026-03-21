export const STELLA_CHAT_COMPLETIONS_PATH = "/api/stella/v1/chat/completions";
export const STELLA_MODELS_PATH = "/api/stella/v1/models";
export const STELLA_DEFAULT_MODEL = "stella/default";

export const normalizeStellaApiBaseUrl = (value: string): string =>
  value.trim().replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "");

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer";
  content: string | Array<{ type?: string; text?: string }>;
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    delta?: {
      content?: string;
    };
  }>;
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
  };
};

export function extractChatText(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}
