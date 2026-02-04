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

export const TASK_POLL_INTERVAL_MS = 750;
export const TASK_MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
