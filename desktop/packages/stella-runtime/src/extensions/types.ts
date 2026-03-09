// Extension system type definitions.
//
// Extensions are auto-discovered from the agents directory:
//   tools/<name>.tool.ts       - Custom tool definitions
//   hooks/<name>.hook.ts       - Lifecycle hooks
//   providers/<name>.provider.ts - Custom LLM providers
//   prompts/<name>.prompt.md   - Reusable prompt templates
//   skills/<name>/SKILL.md     - Agent skills (already supported)
//   agents/<name>/AGENT.md     - Agent definitions (already supported)

import type { ToolContext, ToolResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hook Definition
// ---------------------------------------------------------------------------

export type HookEvent =
  | "before_tool"
  | "after_tool"
  | "before_agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "before_compact"
  | "before_provider_request";

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

export type BeforeAgentStartPayload = {
  agentType: string;
  systemPrompt: string;
};

export type BeforeAgentStartHookResult = {
  systemPromptAppend?: string;
  systemPromptReplace?: string;
};

export type AgentEndPayload = {
  agentType: string;
  finalText: string;
};

export type TurnStartPayload = {
  agentType: string;
  messageCount: number;
};

export type TurnStartHookResult = {
  injectSystemContent?: string;
};

export type TurnEndPayload = {
  agentType: string;
  assistantText: string;
};

export type BeforeCompactPayload = {
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

export type BeforeProviderRequestPayload = {
  agentType: string;
  model: string;
  payload: unknown;
};

export type BeforeProviderRequestHookResult = {
  payload?: unknown;
};

/** Map from hook event to its payload and result types. */
export interface HookEventMap {
  before_tool: { payload: BeforeToolPayload; result: BeforeToolHookResult };
  after_tool: { payload: AfterToolPayload; result: AfterToolHookResult };
  before_agent_start: { payload: BeforeAgentStartPayload; result: BeforeAgentStartHookResult };
  agent_end: { payload: AgentEndPayload; result: void };
  turn_start: { payload: TurnStartPayload; result: TurnStartHookResult };
  turn_end: { payload: TurnEndPayload; result: void };
  before_compact: { payload: BeforeCompactPayload; result: BeforeCompactHookResult };
  before_provider_request: { payload: BeforeProviderRequestPayload; result: BeforeProviderRequestHookResult };
}

export interface HookDefinition<E extends HookEvent = HookEvent> {
  /** Which lifecycle event to hook into. */
  event: E;
  /** Optional filter - only trigger for matching tools or agent types. */
  filter?: { tool?: string; agentType?: string };
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

// ---------------------------------------------------------------------------
// Loaded extensions bundle
// ---------------------------------------------------------------------------

export interface LoadedExtensions {
  tools: ToolDefinition[];
  hooks: HookDefinition[];
  providers: ProviderDefinition[];
  prompts: PromptTemplate[];
}
