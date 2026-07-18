import crypto from "crypto";
import type {
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../../ai/types.js";
import {
  DEFAULT_CLAUDE_CODE_MODEL,
  getAgentRuntimeEngine,
  getModelOverride,
  loadLocalPreferences,
} from "../preferences/local-preferences.js";
import type {
  AgentModelReasoningEffort,
  AgentRuntimeEngine,
} from "../../contracts/agent-engine.js";
import {
  resolveLocalCliCwd,
  textFromUnknown,
} from "../agent-runtime/shared.js";
import type { ToolMetadata, ToolResult } from "../tools/types.js";
import {
  closeClaudeCodeSessionWhenIdle,
  isClaudeCodeModel,
  runClaudeCodeTurn,
} from "./claude-code-session-runtime.js";

export type ClaudeCodeAgentRuntimeEngine = AgentRuntimeEngine;
export const CLAUDE_CODE_LIGHT_MODEL = "haiku";

export const shouldUseClaudeCodeAgentRuntime = (args: {
  stellaAppDir?: string;
  agentEngine?: ClaudeCodeAgentRuntimeEngine;
  modelId?: string;
}): boolean => {
  if (args.agentEngine === "claude_code_local") {
    return true;
  }
  if (args.agentEngine && args.agentEngine !== "default") {
    return false;
  }
  if (args.modelId && isClaudeCodeModel(args.modelId)) {
    return true;
  }
  // A resolved per-run `default` engine is authoritative. In particular,
  // plain spawn_agent model pins use it to override a saved Claude Code
  // preference for that spawn. Only callers that omit agentEngine entirely
  // should fall back to reading the persisted preference below.
  if (args.agentEngine === "default") {
    return false;
  }
  const stellaAppDir = args.stellaAppDir?.trim();
  return stellaAppDir
    ? getAgentRuntimeEngine(stellaAppDir) === "claude_code_local"
    : false;
};

export const getClaudeCodeAgentModelId = (
  stellaAppDir?: string,
  stellaModel?: string,
  agentType?: string,
  modelOverride?: string,
): string => {
  // A per-spawn pin (spawn_agent `model: claude-code/<model>`) wins for this
  // one run and never touches the saved claudeCodeModel preference.
  const pinnedModel = modelOverride?.trim();
  if (pinnedModel) {
    return `claude-code/${pinnedModel}`;
  }
  const configuredStellaModel =
    stellaModel ??
    (stellaAppDir && agentType
      ? getModelOverride(stellaAppDir, agentType)
      : undefined);
  const lightDefault =
    configuredStellaModel?.trim() === "stella/light"
      ? CLAUDE_CODE_LIGHT_MODEL
      : undefined;
  const prefs = stellaAppDir ? loadLocalPreferences(stellaAppDir) : null;
  const preferredModel = prefs?.claudeCodeModel;
  const userSelectedModel =
    preferredModel && preferredModel !== DEFAULT_CLAUDE_CODE_MODEL
      ? preferredModel
      : undefined;
  const model =
    userSelectedModel ??
    lightDefault ??
    preferredModel ??
    DEFAULT_CLAUDE_CODE_MODEL;
  return `claude-code/${model || DEFAULT_CLAUDE_CODE_MODEL}`;
};

/**
 * Map the stored reasoning effort to a Claude Code `CLAUDE_CODE_EFFORT_LEVEL`
 * value. Returns undefined for "default" so the CLI keeps its model default.
 * Claude Code has no "minimal" tier, so it folds into "low".
 */
const CLAUDE_CODE_EFFORT_BY_REASONING: Record<
  Exclude<AgentModelReasoningEffort, "none">,
  string
> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

export const getClaudeCodeRuntimeEffortLevel = (
  stellaAppDir?: string,
  spawnOverride?: AgentModelReasoningEffort,
): string | undefined => {
  // A spawn suffix is authoritative for this run only and never writes the
  // engine-wide preference or environment configuration.
  if (spawnOverride === "none") return undefined;
  if (spawnOverride) return CLAUDE_CODE_EFFORT_BY_REASONING[spawnOverride];
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
  if (envOverride) return envOverride;
  const prefs = stellaAppDir ? loadLocalPreferences(stellaAppDir) : null;
  const effort = prefs?.claudeCodeReasoningEffort;
  if (!effort || effort === "default") return undefined;
  return CLAUDE_CODE_EFFORT_BY_REASONING[effort];
};

type PromptContentPart =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCall;

const contentPartToText = (part: PromptContentPart): string => {
  if (part.type === "text") return part.text;
  if (part.type === "thinking") return part.thinking;
  if (part.type === "image") return `[Image: ${part.mimeType}]`;
  if (part.type === "toolCall") {
    return [`[Tool call: ${part.name}]`, textFromUnknown(part.arguments)]
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

const messageContentToText = (message: Message): string =>
  (typeof message.content === "string"
    ? message.content
    : message.content
        .map(contentPartToText)
        .filter((part) => part.trim().length > 0)
        .join("\n\n")
  ).trim();

const formatPromptMessage = (message: Message, index: number): string => {
  const text = messageContentToText(message);
  if (!text) return "";
  return [`### ${message.role} ${index + 1}`, text].join("\n");
};

const buildPromptFromMessages = (messages: Message[]): string =>
  messages
    .map(formatPromptMessage)
    .filter((message) => message.trim().length > 0)
    .join("\n\n");

const toolsToMetadata = (tools: Tool[] | undefined): ToolMetadata[] =>
  (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
  }));

export const runClaudeCodeAgentTextCompletion = async (args: {
  /**
   * Stella DATA dir: where local preferences (claudeCodeModel, reasoning
   * effort, per-agent model overrides) live. Used for model/effort selection
   * only — it is NOT the CLI working directory unless no `cwd` is given.
   */
  stellaAppDir: string;
  agentType: string;
  context: Context;
  runId?: string;
  sessionKey?: string;
  abortSignal?: AbortSignal;
  stellaModel?: string;
  /** Internal utility passes may pin effort independently of user agent prefs. */
  effortLevel?: string;
  /**
   * Explicit CLI working directory. Callers whose data dir differs from the
   * agent workspace should pass this; otherwise the cwd falls back to
   * `resolveLocalCliCwd` over `stellaAppDir`.
   */
  cwd?: string;
  executeTool?: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  /** Diagnostic boundary forwarded from finalized Claude assistant events. */
  onModelRound?: (args: {
    messageId?: string;
    toolCallCount: number;
  }) => void;
}): Promise<string> => {
  const runId =
    args.runId ?? `claude-code:${args.agentType}:${crypto.randomUUID()}`;
  const modelId = getClaudeCodeAgentModelId(
    args.stellaAppDir,
    args.stellaModel,
    args.agentType,
  );
  const effortLevel =
    args.effortLevel ?? getClaudeCodeRuntimeEffortLevel(args.stellaAppDir);
  const sessionKey = args.sessionKey ?? `${args.agentType}:one-shot:${runId}`;
  try {
    const result = await runClaudeCodeTurn({
      runId,
      sessionKey,
      modelId,
      ...(effortLevel ? { effortLevel } : {}),
      prompt: buildPromptFromMessages(args.context.messages),
      systemPrompt: args.context.systemPrompt,
      cwd:
        args.cwd?.trim() ||
        resolveLocalCliCwd({
          agentType: args.agentType,
          stellaAppDir: args.stellaAppDir,
        }),
      tools: toolsToMetadata(args.context.tools),
      abortSignal: args.abortSignal,
      ...(args.onModelRound ? { onModelRound: args.onModelRound } : {}),
      executeTool: async (toolCallId, toolName, toolArgs, signal) => {
        if (!args.executeTool) {
          return { error: `Tool ${toolName} is not available in this run.` };
        }
        return args.executeTool(toolCallId, toolName, toolArgs, signal);
      },
    });
    return result.text;
  } finally {
    // Callers that provide a stable key own that reusable utility session's
    // lifecycle. Anonymous text completions remain truly one-shot.
    if (!args.sessionKey) closeClaudeCodeSessionWhenIdle(sessionKey);
  }
};
