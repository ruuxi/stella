import {
  createServiceRequest,
  postServiceJson,
} from "@/platform/http/service-request";
import {
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_DEFAULT_MODEL,
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@/shared/stella-api";

export { extractChatText };

type ChatRequestBase = {
  agentType: string;
  messages: ChatMessage[];
  path?: string;
  headers?: Record<string, string>;
};

type ChatJsonRequest = ChatRequestBase & {
  body?: Record<string, unknown>;
};

export type StellaLlmMessageRequest = {
  messages: ChatMessage[];
  prompt?: never;
  systemPrompt?: never;
};

export type StellaLlmPromptRequest = {
  prompt: string;
  systemPrompt?: string;
  messages?: ChatMessage[];
};

export type StellaLlmRequestBase = (
  | StellaLlmMessageRequest
  | StellaLlmPromptRequest
) & {
  agentType?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  body?: Record<string, unknown>;
};

export type StellaLlmJsonRequest = StellaLlmRequestBase & {
  stream?: false;
};

export type StellaLlmStreamRequest = StellaLlmRequestBase & {
  stream: true;
};

export type StellaLlmRequest = StellaLlmJsonRequest | StellaLlmStreamRequest;

export interface StellaLlmTextOptions {
  agentType?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  body?: Record<string, unknown>;
}

const messagesFromPrompt = (
  prompt: string,
  systemPrompt?: string,
  messages: ChatMessage[] = [],
): ChatMessage[] => [
  ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
  ...messages,
  { role: "user", content: prompt },
];

const messagesForRequest = (options: StellaLlmRequest): ChatMessage[] =>
  typeof options.prompt === "string"
    ? messagesFromPrompt(options.prompt, options.systemPrompt, options.messages)
    : options.messages !== undefined
    ? options.messages
    : [];

const bodyForStellaLlm = (options: StellaLlmRequest): Record<string, unknown> => ({
  ...options.body,
  model: options.model ?? STELLA_DEFAULT_MODEL,
  messages: messagesForRequest(options),
  ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
  ...(options.temperature != null ? { temperature: options.temperature } : {}),
  stream: options.stream ?? false,
});

const requestOptionsForStellaLlm = (options: StellaLlmRequest) => ({
  headers: {
    "X-Stella-Agent-Type": options.agentType ?? "app",
  },
  errorMessage: (response: Response) =>
    `Stella LLM call failed with HTTP ${response.status}`,
});

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  return await postServiceJson<TResponse>(
    options.path ?? STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
    {
      ...options.body,
      messages: options.messages,
    },
    {
      headers: {
        ...options.headers,
        "X-Stella-Agent-Type": options.agentType,
      },
      errorMessage: (response) =>
        `Chat completion failed with HTTP ${response.status}`,
    },
  );
}

export async function callStellaLlm<TResponse = ChatCompletionResponse>(
  options: StellaLlmJsonRequest,
): Promise<TResponse>;
export async function callStellaLlm(
  options: StellaLlmStreamRequest,
): Promise<Response>;
export async function callStellaLlm<TResponse = ChatCompletionResponse>(
  options: StellaLlmRequest,
): Promise<TResponse | Response> {
  if (options.stream === true) {
    const { endpoint, headers } = await createServiceRequest(
      STELLA_CHAT_COMPLETIONS_PATH,
      {
        ...requestOptionsForStellaLlm(options).headers,
        "Content-Type": "application/json",
      },
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyForStellaLlm(options)),
    });
    if (!response.ok) {
      throw new Error(`Stella LLM call failed with HTTP ${response.status}`);
    }
    return response;
  }

  return await postServiceJson<TResponse>(
    STELLA_CHAT_COMPLETIONS_PATH,
    bodyForStellaLlm(options),
    requestOptionsForStellaLlm(options),
  );
}

export async function callStellaLlmText(
  prompt: string,
  options: StellaLlmTextOptions = {},
): Promise<string> {
  const response = await callStellaLlm({
    agentType: options.agentType,
    model: options.model,
    prompt,
    systemPrompt: options.systemPrompt,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    body: options.body,
  });
  return extractChatText(response).trim();
}
