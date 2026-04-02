import type { AgentTool } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import { localActivateSkill } from "../tools/local-tool-overrides.js";
import {
  DEVICE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
} from "../tools/schemas.js";
import type { ToolContext, ToolMetadata, ToolResult } from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { TOOL_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import { AnyToolArgsSchema, textFromUnknown } from "./shared.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import {
  getMcpToolDescription,
  getMcpToolSchema,
} from "../mcp/mcp-tool-metadata-registry.js";

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
  taskId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaHome: string;
  frontendRoot?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  delegationAllowlist?: string[];
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  defaultSkills?: string[];
  skillIds?: string[];
  store: RuntimeStore;
  loadTools?: (args: {
    taskId?: string;
    prompt: string;
    loadedToolNames: string[];
  }) => Promise<{ addedTools: string[]; currentTools: string[] }>;
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

  const toolMetadata = new Map<string, ToolMetadata>(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const activeTools: AgentTool[] = [];
  const activeToolNames = new Set<string>();

  const getToolMetadata = (toolName: string): ToolMetadata => ({
    name: toolName,
    description:
      toolMetadata.get(toolName)?.description ??
      TOOL_DESCRIPTIONS[toolName] ??
      getMcpToolDescription(toolName) ??
      `${toolName} tool`,
    parameters:
      toolMetadata.get(toolName)?.parameters ??
      ((TOOL_JSON_SCHEMAS[toolName] ??
        getMcpToolSchema(toolName) ??
        AnyToolArgsSchema) as Record<string, unknown>),
  });

  const buildContext = (toolCallId: string): ToolContext => ({
    conversationId: opts.conversationId,
    deviceId: opts.deviceId,
    requestId: toolCallId,
    runId: opts.runId,
    ...(opts.rootRunId ? { rootRunId: opts.rootRunId } : {}),
    agentType: opts.agentType,
    ...(opts.frontendRoot ? { frontendRoot: opts.frontendRoot } : {}),
    storageMode: "local",
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
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
  });

  const registerTool = (toolName: string): AgentTool => {
    const metadata = getToolMetadata(toolName);
    const tool: AgentTool = {
      name: toolName,
      label: toolName,
      description: metadata.description,
      parameters: metadata.parameters as typeof AnyToolArgsSchema,
      execute: async (toolCallId, params, signal) => {
        const args = (params as Record<string, unknown>) ?? {};

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

        if (toolName === "LoadTools") {
          if (!opts.loadTools) {
            return {
              content: [{ type: "text", text: "LoadTools is not available." }],
              details: { addedTools: [], currentTools: [...activeToolNames] },
            };
          }
          const prompt =
            (typeof args.prompt === "string" ? args.prompt : "") ||
            (typeof args.request === "string" ? args.request : "");
          const loaded = await opts.loadTools({
            taskId: opts.taskId,
            prompt,
            loadedToolNames: [...activeToolNames],
          });
          for (const loadedToolName of loaded.currentTools) {
            if (activeToolNames.has(loadedToolName)) continue;
            activeToolNames.add(loadedToolName);
            activeTools.push(registerTool(loadedToolName));
          }
          const text =
            loaded.addedTools.length > 0
              ? `Loaded tools: ${loaded.addedTools.join(", ")}`
              : "No additional tools were loaded.";
          return {
            content: [{ type: "text", text }],
            details: loaded,
          };
        }

        const localResult = await dispatchLocalTool(toolName, args, {
          conversationId: opts.conversationId,
          webSearch: opts.webSearch,
          store: opts.store,
        });
        if (localResult.handled) {
          return {
            content: [{ type: "text", text: localResult.text }],
            details: { text: localResult.text },
          };
        }

        const context = buildContext(toolCallId);
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
    };
    return tool;
  };

  for (const toolName of requested) {
    if (activeToolNames.has(toolName)) continue;
    activeToolNames.add(toolName);
    activeTools.push(registerTool(toolName));
  }

  return activeTools;
};
