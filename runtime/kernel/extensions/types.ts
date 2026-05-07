import type { ToolContext, ToolResult } from "../tools/types.js";
import type { ParsedAgent } from "../agents/types.js";
import type {
  AgentMessage,
  AgentToolResult,
} from "../agent-core/types.js";
import type { AssistantMessageEvent } from "../../ai/types.js";

export interface ToolDefinition {
  /** Tool name (must be unique). */
  name: string;
  /** One-line description for the LLM. */
  description: string;
  /** Which agent types can use this tool. Omit for all. */
  agentTypes?: string[];
  /** JSON Schema for tool parameters. */
  parameters: Record<string, unknown>;
  /** Execute the tool. */
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

export type HookEvent =
  | "before_tool"
  | "after_tool"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "before_compact"
  | "session_compact"
  | "before_provider_request"
  | "after_provider_response"
  | "session_start"
  | "session_shutdown";

/** Common runtime context fields available on most hook payloads. */
export type HookRuntimeContext = {
  /** Conversation this run belongs to (orchestrator: stable per chat; subagent: parent's). */
  conversationId?: string;
  /** Engine thread key (orchestrator: conversationId; subagent: namespaced per task). */
  threadKey?: string;
  /** Run id for the in-flight run, if any. */
  runId?: string;
  /** True when this run is a real user-driven turn (uiVisibility !== "hidden"). */
  isUserTurn?: boolean;
  /** UI visibility for the run; mirrors RuntimeRunCallbacks payloads. */
  uiVisibility?: "visible" | "hidden";
};

export type BeforeToolPayload = {
  tool: string;
  args: Record<string, unknown>;
  context: ToolContext;
};

export type BeforeToolHookResult = {
  cancel?: boolean;
  reason?: string;
  args?: Record<string, unknown>;
};

export type AfterToolPayload = {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  context: ToolContext;
};

export type AfterToolHookResult = {
  result?: ToolResult;
};

export type BeforeAgentStartPayload = HookRuntimeContext & {
  agentType: string;
  systemPrompt: string;
};

export type BeforeAgentStartHookResult = {
  systemPromptAppend?: string;
  systemPromptReplace?: string;
};

export type AgentStartPayload = HookRuntimeContext & {
  agentType: string;
};

export type AgentEndPayload = HookRuntimeContext & {
  agentType: string;
  /**
   * Final assistant text on success, the error message on failures, or
   * the interruption reason on cancellation. Hook consumers should
   * branch on `outcome` rather than treat this as ground truth.
   */
  finalText: string;
  /** Fires for every terminal outcome; success-only consumers must gate explicitly. */
  outcome: "success" | "error" | "interrupted";
};

export type AgentEndHookResult = {
  selfModApplied?: {
    featureId: string;
    files: string[];
    batchIndex: number;
  };
};

export type TurnStartPayload = HookRuntimeContext & {
  agentType: string;
  messageCount: number;
};

export type TurnStartHookResult = {
  injectSystemContent?: string;
};

export type TurnEndPayload = HookRuntimeContext & {
  agentType: string;
  assistantText: string;
};

export type MessageStartPayload = HookRuntimeContext & {
  agentType: string;
  message: AgentMessage;
};

export type MessageUpdatePayload = HookRuntimeContext & {
  agentType: string;
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
};

export type MessageEndPayload = HookRuntimeContext & {
  agentType: string;
  message: AgentMessage;
};

/** `message_end` is observation-only and fires after persistence. */
export type MessageEndHookResult = void;

export type ToolExecutionStartPayload = HookRuntimeContext & {
  agentType: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type ToolExecutionUpdatePayload = HookRuntimeContext & {
  agentType: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: AgentToolResult<unknown>;
};

export type ToolExecutionEndPayload = HookRuntimeContext & {
  agentType: string;
  toolCallId: string;
  toolName: string;
  result: AgentToolResult<unknown>;
  isError: boolean;
};

export type BeforeCompactPayload = HookRuntimeContext & {
  agentType: string;
  messageCount: number;
};

export type BeforeCompactHookResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    preserveLastN?: number;
  };
};

export type SessionCompactPayload = HookRuntimeContext & {
  agentType: string;
  summary: string;
  preserveLastN?: number;
  /** True if the compaction summary was supplied by a `before_compact` hook. */
  fromHook: boolean;
};

export type BeforeProviderRequestPayload = HookRuntimeContext & {
  agentType: string;
  model: string;
  payload: unknown;
};

export type BeforeProviderRequestHookResult = {
  payload?: unknown;
};

export type AfterProviderResponsePayload = HookRuntimeContext & {
  agentType: string;
  model: string;
  status?: number;
  headers?: Record<string, string>;
};

export type SessionStartPayload = HookRuntimeContext & {
  agentType: string;
  reason: "startup" | "new" | "resume" | "fork" | "reload";
  previousThreadKey?: string;
};

export type SessionShutdownPayload = HookRuntimeContext & {
  agentType: string;
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetThreadKey?: string;
};

/** Map from hook event to its payload and result types. */
export interface HookEventMap {
  before_tool: { payload: BeforeToolPayload; result: BeforeToolHookResult };
  after_tool: { payload: AfterToolPayload; result: AfterToolHookResult };
  before_agent_start: { payload: BeforeAgentStartPayload; result: BeforeAgentStartHookResult };
  agent_start: { payload: AgentStartPayload; result: void };
  agent_end: { payload: AgentEndPayload; result: AgentEndHookResult };
  turn_start: { payload: TurnStartPayload; result: TurnStartHookResult };
  turn_end: { payload: TurnEndPayload; result: void };
  message_start: { payload: MessageStartPayload; result: void };
  message_update: { payload: MessageUpdatePayload; result: void };
  message_end: { payload: MessageEndPayload; result: MessageEndHookResult };
  tool_execution_start: { payload: ToolExecutionStartPayload; result: void };
  tool_execution_update: { payload: ToolExecutionUpdatePayload; result: void };
  tool_execution_end: { payload: ToolExecutionEndPayload; result: void };
  before_compact: { payload: BeforeCompactPayload; result: BeforeCompactHookResult };
  session_compact: { payload: SessionCompactPayload; result: void };
  before_provider_request: { payload: BeforeProviderRequestPayload; result: BeforeProviderRequestHookResult };
  after_provider_response: { payload: AfterProviderResponsePayload; result: void };
  session_start: { payload: SessionStartPayload; result: void };
  session_shutdown: { payload: SessionShutdownPayload; result: void };
}

export interface HookDefinition<E extends HookEvent = HookEvent> {
  /** Which lifecycle event to hook into. */
  event: E;
  /** Optional filter - only trigger for matching tools or agent types. */
  filter?: { tool?: string; agentType?: string };
  /**
   * Where this hook came from. Bundled hooks ship with Stella and survive
   * extension hot-reloads; user-installable extensions are tagged
   * "extension" so a reload can replace them without touching bundled
   * behavior. Defaults to "extension" when unset; bundled registrations
   * set it explicitly via `registerBundledHooks`.
   */
  source?: "bundled" | "extension";
  /** Hook handler. Return a result object to modify behavior, or void to observe only. */
  handler(
    payload: HookEventMap[E]["payload"],
  ): Promise<HookEventMap[E]["result"] | void>;
}

// ---------------------------------------------------------------------------
// Provider Definition
// ---------------------------------------------------------------------------

export interface ProviderModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ProviderDefinition {
  /** Unique provider name. */
  name: string;
  /** API compatibility type (e.g. "openai-completions", "anthropic-messages"). */
  api: string;
  /** Base URL for the provider API. */
  baseUrl: string;
  /** Environment variable name for the API key. */
  apiKeyEnv?: string;
  /** Available models. */
  models: ProviderModelDefinition[];
  /** Additional request headers. */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Prompt Template
// ---------------------------------------------------------------------------

export interface PromptTemplate {
  /** Prompt name (derived from filename if not in frontmatter). */
  name: string;
  /** Short description. */
  description: string;
  /** The template body, may contain {{variable}} placeholders. */
  template: string;
  /** Source file path. */
  filePath: string;
}

export interface ExtensionRegistrationApi {
  on<E extends HookEvent>(
    event: E,
    handler: HookDefinition<E>["handler"],
    filter?: HookDefinition<E>["filter"],
  ): void;
  registerTool(tool: ToolDefinition): void;
  registerProvider(provider: ProviderDefinition): void;
  registerPrompt(prompt: PromptTemplate): void;
  registerAgent(agent: ParsedAgent): void;
}

export type ExtensionFactory = (
  api: ExtensionRegistrationApi,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Loaded extensions bundle
// ---------------------------------------------------------------------------

export interface LoadedExtensions {
  tools: ToolDefinition[];
  hooks: HookDefinition[];
  providers: ProviderDefinition[];
  prompts: PromptTemplate[];
  agents: ParsedAgent[];
}
