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
import { getAgentRuntimeEngine } from "../preferences/local-preferences.js";
import { resolveLocalCliCwd, textFromUnknown } from "../agent-runtime/shared.js";
import type { ToolMetadata, ToolResult } from "../tools/types.js";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
} from "./claude-code-session-runtime.js";

export type ClaudeCodeAgentRuntimeEngine = "default" | "claude_code_local";

export const shouldUseClaudeCodeAgentRuntime = (args: {
  stellaRoot?: string;
  agentEngine?: ClaudeCodeAgentRuntimeEngine;
  modelId?: string;
}): boolean => {
  if (args.agentEngine === "claude_code_local") {
    return true;
  }
  if (args.modelId && isClaudeCodeModel(args.modelId)) {
    return true;
  }
  const stellaRoot = args.stellaRoot?.trim();
  return stellaRoot
    ? getAgentRuntimeEngine(stellaRoot) === "claude_code_local"
    : false;
};

export const getClaudeCodeAgentModelId = (): string => "claude-code/default";

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
  stellaRoot: string;
  agentType: string;
  context: Context;
  runId?: string;
  sessionKey?: string;
  abortSignal?: AbortSignal;
  executeTool?: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}): Promise<string> => {
  const runId = args.runId ?? `claude-code:${args.agentType}:${crypto.randomUUID()}`;
  const modelId = getClaudeCodeAgentModelId();
  const result = await runClaudeCodeTurn({
    runId,
    sessionKey: args.sessionKey ?? `${args.agentType}:one-shot:${runId}`,
    modelId,
    prompt: buildPromptFromMessages(args.context.messages),
    systemPrompt: args.context.systemPrompt,
    cwd: resolveLocalCliCwd({
      agentType: args.agentType,
      stellaRoot: args.stellaRoot,
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
