import type { Id } from "../_generated/dataModel";

export type PluginToolDescriptor = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  currentTaskId?: Id<"tasks">;
  pluginTools: PluginToolDescriptor[];
  ownerId?: string;
};

export const BASE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "AgentInvoke",
  "Task",
  "AskUserQuestion",
  "RequestCredential",
  "IntegrationRequest",
  "Scheduler",
  "SkillBash",
  "SqliteQuery",
  "MediaGenerate",
  "MemorySearch",
  "ActivateSkill",
] as const;
