import type { AgentTool } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import {
  localActivateSkill,
  localNoResponse,
  localWebFetch,
} from "../tools/local-tool-overrides.js";
import {
  DEVICE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
} from "../tools/schemas.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { TOOL_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import { AnyToolArgsSchema, textFromUnknown } from "./shared.js";

const STELLA_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  "TaskUpdate",
  "TaskCreate",
  "TaskCancel",
  "TaskOutput",
  TOOL_IDS.WEB_FETCH,
  TOOL_IDS.ACTIVATE_SKILL,
  TOOL_IDS.NO_RESPONSE,
  TOOL_IDS.SAVE_MEMORY,
  TOOL_IDS.RECALL_MEMORIES,
] as const;

const getRecallQuery = (args: Record<string, unknown>): string =>
  typeof args.query === "string" ? args.query : "";

const getSaveMemoryText = (args: Record<string, unknown>): string =>
  typeof args.content === "string" ? args.content : "";

const formatToolResult = (
  toolResult: ToolResult,
): { text: string; details: unknown } => {
  if (toolResult.error) {
    return {
      text: `Error: ${toolResult.error}`,
      details: { error: toolResult.error },
    };
  }

  return {
    text: textFromUnknown(toolResult.result),
    details: toolResult.result,
  };
};

export const createPiTools = (opts: {
  runId: string;
  rootRunId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaHome: string;
  frontendRoot?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  delegationAllowlist?: string[];
  toolsAllowlist?: string[];
  defaultSkills?: string[];
  skillIds?: string[];
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  webSearch?: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  hookEmitter?: HookEmitter;
}): AgentTool[] => {
  const requested =
    Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0
      ? opts.toolsAllowlist
      : [...STELLA_LOCAL_TOOLS];

  const uniqueToolNames = Array.from(new Set(requested));

  const buildTool = (toolName: string): AgentTool => ({
    name: toolName,
    label: toolName,
    description: TOOL_DESCRIPTIONS[toolName] ?? `${toolName} tool`,
    parameters: (TOOL_JSON_SCHEMAS[toolName] ??
      AnyToolArgsSchema) as typeof AnyToolArgsSchema,
    execute: async (toolCallId, params, signal) => {
      const args = (params as Record<string, unknown>) ?? {};

      if (toolName === TOOL_IDS.WEB_SEARCH) {
        const query = typeof args.query === "string" ? args.query : "";
        if (!opts.webSearch) {
          return {
            content: [{ type: "text", text: "WebSearch is not available." }],
            details: {},
          };
        }
        const category =
          typeof args.category === "string" ? args.category : undefined;
        const result = await opts.webSearch(query, { category });
        return {
          content: [
            {
              type: "text",
              text: result.text || "WebSearch returned no response.",
            },
          ],
          details: result,
        };
      }

      if (toolName === TOOL_IDS.WEB_FETCH) {
        const url = typeof args.url === "string" ? args.url : "";
        const prompt =
          typeof args.prompt === "string" ? args.prompt : undefined;
        const text = await localWebFetch({ url, prompt });
        return { content: [{ type: "text", text }], details: { text } };
      }

      if (toolName === TOOL_IDS.ACTIVATE_SKILL) {
        const skillId =
          (typeof args.skillId === "string" ? args.skillId : undefined) ??
          (typeof args.skill_id === "string" ? args.skill_id : "");
        const text = await localActivateSkill({
          skillId,
          stellaHome: opts.stellaHome,
          allowedSkillIds: opts.skillIds,
        });
        return { content: [{ type: "text", text }], details: { text } };
      }

      if (toolName === TOOL_IDS.NO_RESPONSE) {
        const text = await localNoResponse();
        return { content: [{ type: "text", text }], details: { text } };
      }

      if (toolName === TOOL_IDS.SAVE_MEMORY) {
        const content = getSaveMemoryText(args);
        const tags = Array.isArray(args.tags)
          ? args.tags.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : undefined;
        opts.store.saveMemory({
          conversationId: opts.conversationId,
          content,
          ...(tags && tags.length > 0 ? { tags } : {}),
        });
        const text = content.trim()
          ? "Saved memory entry."
          : "No memory content provided.";
        return { content: [{ type: "text", text }], details: { ok: true } };
      }

      if (toolName === TOOL_IDS.RECALL_MEMORIES) {
        const query = getRecallQuery(args);
        const requestedLimit =
          typeof args.limit === "number" ? args.limit : undefined;
        const rows = opts.store.recallMemories({
          query,
          ...(requestedLimit ? { limit: requestedLimit } : {}),
        });
        const text =
          rows.length > 0
            ? rows
                .map((row, index) => `${index + 1}. ${row.content}`)
                .join("\n")
            : "No matching memories found.";
        return { content: [{ type: "text", text }], details: { rows } };
      }

      const context: ToolContext = {
        conversationId: opts.conversationId,
        deviceId: opts.deviceId,
        requestId: toolCallId,
        runId: opts.runId,
        ...(opts.rootRunId ? { rootRunId: opts.rootRunId } : {}),
        agentType: opts.agentType,
        ...(opts.frontendRoot ? { frontendRoot: opts.frontendRoot } : {}),
        storageMode: "local",
        ...(typeof opts.taskDepth === "number"
          ? { taskDepth: opts.taskDepth }
          : {}),
        ...(typeof opts.maxTaskDepth === "number"
          ? { maxTaskDepth: opts.maxTaskDepth }
          : {}),
        ...(opts.delegationAllowlist
          ? { delegationAllowlist: opts.delegationAllowlist }
          : {}),
        ...(opts.defaultSkills ? { defaultSkills: opts.defaultSkills } : {}),
        ...(opts.skillIds ? { skillIds: opts.skillIds } : {}),
      };

      let effectiveArgs = args;
      if (opts.hookEmitter) {
        const hookResult = await opts.hookEmitter.emit(
          "before_tool",
          { tool: toolName, args, context },
          { tool: toolName, agentType: opts.agentType },
        );
        if (hookResult?.cancel) {
          return {
            content: [
              {
                type: "text",
                text: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}`,
              },
            ],
            details: { blocked: true },
          };
        }
        if (hookResult?.args) {
          effectiveArgs = hookResult.args;
        }
      }

      let toolResult = await opts.toolExecutor(
        toolName,
        effectiveArgs,
        context,
        signal,
      );

      if (opts.hookEmitter) {
        const hookResult = await opts.hookEmitter.emit(
          "after_tool",
          { tool: toolName, args: effectiveArgs, result: toolResult, context },
          { tool: toolName, agentType: opts.agentType },
        );
        if (hookResult?.result) {
          toolResult = hookResult.result;
        }
      }

      const formatted = formatToolResult(toolResult);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: formatted.details,
      };
    },
  });

  return uniqueToolNames.map(buildTool);
};
