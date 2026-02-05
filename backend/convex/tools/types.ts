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
  "KillShell",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TestWrite",
  "AgentInvoke",
  "Task",
  "TaskOutput",
  "TaskCancel",
  "AskUserQuestion",
  "RequestCredential",
  "IntegrationRequest",
  "Scheduler",
  "SkillBash",
  "SqliteQuery",
  "ImageGenerate",
  "ImageEdit",
  "VideoGenerate",
  "MemorySearch",
  "ActivateSkill",
] as const;
