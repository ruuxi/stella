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
  type ReasoningEffort,
} from "../preferences/local-preferences.js";
import type { AgentRuntimeEngine } from "../../contracts/agent-engine.js";
import { resolveLocalCliCwd, textFromUnknown } from "../agent-runtime/shared.js";
import type { ToolMetadata, ToolResult } from "../tools/types.js";
import {
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
  const stellaAppDir = args.stellaAppDir?.trim();
  return stellaAppDir
    ? getAgentRuntimeEngine(stellaAppDir) === "claude_code_local"
    : false;
};

export const getClaudeCodeAgentModelId = (
  stellaAppDir?: string,
  stellaModel?: string,
  agentType?: string,
): string => {
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
  Exclude<ReasoningEffort, "default">,
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
): string | undefined => {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
  if (envOverride) return envOverride;
  const prefs = stellaAppDir ? loadLocalPreferences(stellaAppDir) : null;
  const effort = prefs?.claudeCodeReasoningEffort;
  if (!effort || effort === "default") return undefined;
  return CLAUDE_CODE_EFFORT_BY_REASONING[effort];
};

type PromptContentPart = TextContent | ImageContent | ThinkingContent | ToolCall;

const contentPartToText = (part: PromptContentPart): string => {
  if (part.type === "text") return part.text;
  if (part.type === "thinking") return part.thinking;
  if (part.type === "image") return `[Image: ${part.mimeType}]`;
  if (part.type === "toolCall") {
    return [
      `[Tool call: ${part.name}]`,
      textFromUnknown(part.arguments),
    ].filter(Boolean).join("\n");
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
  stellaAppDir: string;
  agentType: string;
  context: Context;
  runId?: string;
  sessionKey?: string;
  abortSignal?: AbortSignal;
  stellaModel?: string;
  executeTool?: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}): Promise<string> => {
  const runId = args.runId ?? `claude-code:${args.agentType}:${crypto.randomUUID()}`;
  const modelId = getClaudeCodeAgentModelId(
    args.stellaAppDir,
    args.stellaModel,
    args.agentType,
  );
  const effortLevel = getClaudeCodeRuntimeEffortLevel(args.stellaAppDir);
  const result = await runClaudeCodeTurn({
    runId,
    sessionKey: args.sessionKey ?? `${args.agentType}:one-shot:${runId}`,
    modelId,
    ...(effortLevel ? { effortLevel } : {}),
    prompt: buildPromptFromMessages(args.context.messages),
    systemPrompt: args.context.systemPrompt,
    cwd: resolveLocalCliCwd({
      agentType: args.agentType,
      stellaAppDir: args.stellaAppDir,
    }),
    tools: toolsToMetadata(args.context.tools),
    abortSignal: args.abortSignal,
    executeTool: async (toolCallId, toolName, toolArgs, signal) => {
      if (!args.executeTool) {
        return { error: `Tool ${toolName} is not available in this run.` };
      }
      return args.executeTool(toolCallId, toolName, toolArgs, signal);
    },
  });
  return result.text;
};
