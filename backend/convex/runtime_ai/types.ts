export type Api =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type Provider = string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CacheRetention = "none" | "short" | "long";

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  headers?: Record<string, string>;
  onPayload?: (
    payload: unknown,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
}

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data?: string;
  mimeType?: string;
  url?: string;
  detail?: "auto" | "low" | "high";
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}

export interface SystemMessage {
  role: "system" | "developer";
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCall>;
  api: Api;
  provider: Provider;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface OpenRouterRouting {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?:
    | string
    | {
        by?: string;
        partition?: string | null;
      };
  max_price?: {
    prompt?: number | string;
    completion?: number | string;
    image?: number | string;
    audio?: number | string;
    request?: number | string;
  };
  preferred_min_throughput?:
    | number
    | { p50?: number; p75?: number; p90?: number; p99?: number };
  preferred_max_latency?:
    | number
    | { p50?: number; p75?: number; p90?: number; p99?: number };
}

export interface VercelGatewayRouting {
  only?: string[];
  order?: string[];
}

export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortMap?: Partial<Record<ThinkingLevel, string>>;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  openRouterRouting?: OpenRouterRouting;
  vercelGatewayRouting?: VercelGatewayRouting;
  zaiToolStream?: boolean;
  supportsStrictMode?: boolean;
}

export interface OpenAIResponsesCompat {}

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses"
      ? OpenAIResponsesCompat
      : never;
}

export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

export type TextSignatureV1 = {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
};

export type AssistantMessageEventStream = import("./event_stream").AssistantMessageEventStream;
