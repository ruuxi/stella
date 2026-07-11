const STELLA_API_BASE_PATH = "/api/stella";
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;
export const STELLA_PROMPTS_PATH = `${STELLA_API_BASE_PATH}/prompts`;
export const STELLA_RELAY_PATH_PREFIX = `${STELLA_API_BASE_PATH}/relay`;
export const STELLA_CHAT_COMPLETIONS_PATH = `${STELLA_RELAY_PATH_PREFIX}/chat/completions`;
export const STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/openrouter/api/v1/chat/completions`;
export const STELLA_DEFAULT_MODEL = "stella/default";
export const STELLA_STANDARD_MODEL = "stella/standard";
export type StellaRelayProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "fireworks"
  | "openrouter";

export const normalizeStellaSiteUrl = (value: string): string =>
  value
    .trim()
    .replace(/\/chat\/completions\/?$/i, "")
    .replace(/\/responses\/?$/i, "")
    .replace(/\/runtime\/?$/i, "")
    .replace(/\/models\/?$/i, "")
    .replace(/\/api\/stella\/v1\/?$/i, "")
    .replace(/\/api\/stella\/relay(?:\/.*)?$/i, "")
    .replace(/\/api\/stella\/(?:anthropic|openai|fireworks)(?:\/v1)?\/?$/i, "")
    .replace(/\/api\/stella\/google\/v1beta\/?$/i, "")
    .replace(/\/api\/stella\/openrouter\/api\/v1\/?$/i, "")
    .replace(/\/api\/stella\/?$/i, "")
    .replace(/\/+$/, "");

const stellaUrlFromSiteUrl = (siteUrl: string, path: string): string =>
  `${normalizeStellaSiteUrl(siteUrl)}${path}`;

export const stellaApiBaseUrlFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_API_BASE_PATH);

export const stellaManagedRelayBaseUrlFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_RELAY_PATH_PREFIX);

type ChatContentPart =
  | { type?: string; text?: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string | ChatContentPart[] | null;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_signature?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | Array<{ type?: string; text?: string }> | null;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      reasoning_signature?: string;
      tool_calls?: ChatToolCall[];
    };
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      reasoning_signature?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
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
