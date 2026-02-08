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
  conversationId?: Id<"conversations">;
};

export const BASE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskOutput",
  "TaskCancel",
  "AskUserQuestion",
  "RequestCredential",
  "IntegrationRequest",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
  "SkillBash",
  "SqliteQuery",
  "MediaGenerate",
  "MemorySearch",
  "ActivateSkill",
  "OpenCanvas",
  "CloseCanvas",
] as const;
